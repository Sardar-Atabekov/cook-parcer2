import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import axios from "axios";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import dotenv from "dotenv";

dotenv.config();

const POSTGRES_URI = process.env.POSTGRES_URI;
if (!POSTGRES_URI) {
  console.error("❌ POSTGRES_URI не установлена.");
  process.exit(1);
}

const pool = new Pool({ connectionString: POSTGRES_URI });
const db = drizzle(pool, { schema });

async function fetchSupercookData(language = "ru") {
  const url = "https://d1.supercook.com/dyn/lang_ings";
  const payload = new URLSearchParams({ lang: language, cv: "2" }).toString();
  try {
    const response = await axios.post(url, payload, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.error(`Ошибка получения данных: ${error.message}`);
    return [];
  }
}

export async function syncSupercookIngredients(language) {
  if (!language) {
    console.warn("⚠️ Язык не указан");
    return;
  }

  console.log(`🚀 Синхронизация Supercook: ${language}`);
  const apiData = await fetchSupercookData(language);
  if (!Array.isArray(apiData) || apiData.length === 0) {
    console.log("📭 Нет данных для обработки");
    return;
  }

  try {
    await db.transaction(async (tx) => {
      const [existingCategories, existingIngredients] = await Promise.all([
        tx.select().from(schema.ingredientCategories),
        tx
          .select({
            id: schema.ingredients.id,
            name: schema.ingredients.name,
            language: schema.ingredients.language,
          })
          .from(schema.ingredients)
          .where(eq(schema.ingredients.isActive, true)),
      ]);

      const categoryMap = new Map(
        existingCategories.map((c) => [c.icon, c.id])
      );

      const ingredientMap = new Map(
        existingIngredients.map((i) => [
          `${i.name.trim().toLowerCase()}__${i.language}`,
          i.id,
        ])
      );

      const newCategories = [];
      const categoryIconToName = new Map();

      for (const item of apiData) {
        const icon = item.icon?.trim();
        const groupName = item.group_name.trim();
        if (!icon) continue;

        categoryIconToName.set(icon, groupName);
        if (!categoryMap.has(icon)) {
          newCategories.push({
            parentId: null,
            level: 0,
            sortOrder: 0,
            isActive: true,
            icon,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      if (newCategories.length > 0) {
        const inserted = await tx
          .insert(schema.ingredientCategories)
          .values(newCategories)
          .returning({
            id: schema.ingredientCategories.id,
            icon: schema.ingredientCategories.icon,
          });

        for (const cat of inserted) {
          categoryMap.set(cat.icon, cat.id);
        }
      }

      const catTranslations = [];
      for (const [icon, name] of categoryIconToName.entries()) {
        const categoryId = categoryMap.get(icon);
        if (!categoryId) continue;

        catTranslations.push({
          categoryId,
          language,
          name,
          description: null,
        });
      }

      if (catTranslations.length > 0) {
        await tx
          .insert(schema.ingredientCategoryTranslations)
          .values(catTranslations)
          .onConflictDoNothing({
            target: [
              schema.ingredientCategoryTranslations.categoryId,
              schema.ingredientCategoryTranslations.language,
            ],
          });
      }

      const newIngredients = [];
      const newIngredientSet = new Set();

      for (const item of apiData) {
        const icon = item.icon?.trim();
        if (!icon) continue;

        for (const rawTerm of item.ingredients) {
          const name = rawTerm.trim();
          const key = `${name.toLowerCase()}__${language}`;
          if (!ingredientMap.has(key) && !newIngredientSet.has(key)) {
            newIngredients.push({
              name,
              language,
              isActive: true,
              aliases: null,
              nutritionalData: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              lastSyncAt: new Date(),
            });
            newIngredientSet.add(key);
          }
        }
      }

      if (newIngredients.length > 0) {
        const inserted = await tx
          .insert(schema.ingredients)
          .values(newIngredients)
          .onConflictDoNothing({
            target: [schema.ingredients.name, schema.ingredients.language],
          })
          .returning({
            id: schema.ingredients.id,
            name: schema.ingredients.name,
          });

        for (const ing of inserted) {
          const key = `${ing.name.trim().toLowerCase()}__${language}`;
          ingredientMap.set(key, ing.id);
        }
      }

      const existingLinks = await tx
        .select({
          ingredientId: schema.ingredientCategoryLinks.ingredientId,
          categoryId: schema.ingredientCategoryLinks.categoryId,
        })
        .from(schema.ingredientCategoryLinks);

      const existingLinksSet = new Set(
        existingLinks.map((l) => `${l.ingredientId}_${l.categoryId}`)
      );

      const newLinks = [];
      const expectedCounts = new Map();
      const actualCounts = new Map();

      for (const item of apiData) {
        const icon = item.icon?.trim();
        const categoryId = categoryMap.get(icon);
        if (!categoryId) continue;

        const uniqueTerms = new Set();

        for (const rawTerm of item.ingredients) {
          const key = `${rawTerm.trim().toLowerCase()}__${language}`;
          if (uniqueTerms.has(key)) continue;
          uniqueTerms.add(key);

          const ingredientId = ingredientMap.get(key);
          if (!ingredientId) continue;

          const linkKey = `${ingredientId}_${categoryId}`;
          if (!existingLinksSet.has(linkKey)) {
            newLinks.push({ ingredientId, categoryId });
            existingLinksSet.add(linkKey);
            actualCounts.set(
              categoryId,
              (actualCounts.get(categoryId) || 0) + 1
            );
          }
        }

        expectedCounts.set(
          categoryId,
          (expectedCounts.get(categoryId) || 0) + uniqueTerms.size
        );
      }

      if (newLinks.length > 0) {
        await tx
          .insert(schema.ingredientCategoryLinks)
          .values(newLinks)
          .onConflictDoNothing({
            target: [
              schema.ingredientCategoryLinks.ingredientId,
              schema.ingredientCategoryLinks.categoryId,
            ],
          });
      }

      console.log("\n📊 Проверка по категориям:");
      for (const [catId, expected] of expectedCounts.entries()) {
        const actual = actualCounts.get(catId) || 0;
        const icon = [...categoryMap.entries()].find(
          ([, id]) => id === catId
        )?.[0];
        const status = expected === actual ? "✅ OK" : "⚠️ Несовпадение";
        console.log(
          `- ${icon || "?"} → API: ${expected}, Связано: ${actual} ${status}`
        );
      }
    });

    console.log(`✅ Синхронизация завершена: ${language}`);
  } catch (error) {
    console.error(`❌ Ошибка при синхронизации: ${error.message}`);
    throw error;
  }
}

export async function getIngredientsByLanguage(language) {
  try {
    const rows = await db
      .select({ name: schema.ingredients.name })
      .from(schema.ingredients)
      .where(
        and(
          eq(schema.ingredients.language, language),
          eq(schema.ingredients.isActive, true)
        )
      );
    return rows.map((r) => r.name);
  } catch (error) {
    console.error("Ошибка в getIngredientsByLanguage:", error.message);
    return [];
  }
}
