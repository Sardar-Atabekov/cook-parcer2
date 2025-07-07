import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import axios from "axios";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
const POSTGRES_URI =
  "postgresql://postgres:GXZEoCNdFehOoXqXVFeJCQLGIjlZCwsu@maglev.proxy.rlwy.net:42374/railway";

const pool = new Pool({
  connectionString: POSTGRES_URI,
});

const db = drizzle(pool, { schema });
// Утилита для удаления дубликатов переводов по ключу ingredientId + language
function deduplicateIngredientTranslations(data) {
  const seen = new Set();
  const result = [];
  for (const item of data) {
    const key = `${item.ingredientId}_${item.language}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

async function fetchSupercookData(language = "ru") {
  const url = "https://d1.supercook.com/dyn/lang_ings";
  const payload = new URLSearchParams({ lang: language, cv: "2" }).toString();
  const response = await axios.post(url, payload, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  // The API returns an array directly, not an object with a 'data' key
  const data = Array.isArray(response.data) ? response.data : response.data;
  return data;
}
export async function getIngredientsByLanguage(language) {
  const rows = await db
    .select({ name: schema.ingredientTranslations.name })
    .from(schema.ingredientTranslations)
    .where(eq(schema.ingredientTranslations.language, language));

  return rows.map((row) => row.name);
}
export async function syncSupercookIngredients(language) {
  if (!language) return;

  const apiData = await fetchSupercookData(language);

  await db.transaction(async (tx) => {
    // --- Загрузка категорий с переводами ---
    const existingCategoryTranslations = await tx
      .select()
      .from(schema.ingredientCategoryTranslations)
      .where(eq(schema.ingredientCategoryTranslations.language, language));

    const categoryMap = new Map();
    for (const ct of existingCategoryTranslations) {
      categoryMap.set(ct.name.toLowerCase(), ct.categoryId);
    }

    // --- Вставка новых категорий ---
    const newCategoriesData = apiData
      .filter((item) => !categoryMap.has(item.group_name.trim().toLowerCase()))
      .map((item) => ({
        parentId: null,
        level: 0,
        sortOrder: 0,
        isActive: true,
        icon: item.icon,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    let insertedCategories = [];
    if (newCategoriesData.length > 0) {
      insertedCategories = await tx
        .insert(schema.ingredientCategories)
        .values(newCategoriesData)
        .returning({ id: schema.ingredientCategories.id });
    }

    // --- Переводы новых категорий ---
    const newCategoryTranslations = insertedCategories
      .map((cat, idx) => ({
        categoryId: cat.id,
        language,
        name:
          apiData
            .find((item) => item.icon === newCategoriesData[idx].icon)
            ?.group_name.trim() ?? "",
        description: null,
      }))
      .filter((ct) => ct.name);

    if (newCategoryTranslations.length > 0) {
      await tx
        .insert(schema.ingredientCategoryTranslations)
        .values(newCategoryTranslations)
        .onConflictDoUpdate({
          target: [
            schema.ingredientCategoryTranslations.categoryId,
            schema.ingredientCategoryTranslations.language,
          ],
          set: {
            name: sql`excluded.name`,
            description: null,
          },
        });
    }

    for (const ct of newCategoryTranslations) {
      categoryMap.set(ct.name.toLowerCase(), ct.categoryId);
    }

    // --- Загрузка существующих ингредиентов ---
    const existingIngredients = await tx
      .select()
      .from(schema.ingredients)
      .where(eq(schema.ingredients.isActive, true));

    const ingredientMap = new Map();
    for (const ing of existingIngredients) {
      ingredientMap.set(ing.primaryName.toLowerCase(), ing.id);
    }

    // --- Сбор новых ингредиентов ---
    const newIngredientsData = [];

    for (const item of apiData) {
      const categoryName = item.group_name.trim().toLowerCase();
      const catId = categoryMap.get(categoryName);
      if (!catId) continue;

      for (const display of item.ingredients) {
        const term = display.trim();
        const key = term.toLowerCase();

        if (!ingredientMap.has(key)) {
          newIngredientsData.push({
            categoryId: catId,
            primaryName: term,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSyncAt: new Date(),
          });
        }
      }
    }

    // --- Вставка новых ингредиентов ---
    let insertedIngredients = [];
    if (newIngredientsData.length > 0) {
      insertedIngredients = await tx
        .insert(schema.ingredients)
        .values(newIngredientsData)
        .returning({
          id: schema.ingredients.id,
          primaryName: schema.ingredients.primaryName,
        });
    }

    for (const ing of insertedIngredients) {
      ingredientMap.set(ing.primaryName.toLowerCase(), ing.id);
    }

    // --- Подготовка переводов для всех ингредиентов ---
    const ingredientTranslationsData = [];

    for (const item of apiData) {
      const categoryName = item.group_name.trim().toLowerCase();
      const catId = categoryMap.get(categoryName);
      if (!catId) continue;

      for (const display of item.ingredients) {
        const term = display.trim();
        const ingredientId = ingredientMap.get(term.toLowerCase());
        if (!ingredientId) continue;

        ingredientTranslationsData.push({
          ingredientId,
          language,
          name: term,
        });
      }
    }

    // --- Удаляем дубликаты переводов по ingredientId + language ---
    const dedupedTranslations = deduplicateIngredientTranslations(
      ingredientTranslationsData
    );

    // --- Вставляем переводы с upsert ---
    if (dedupedTranslations.length > 0) {
      await tx
        .insert(schema.ingredientTranslations)
        .values(dedupedTranslations)
        .onConflictDoUpdate({
          target: [
            schema.ingredientTranslations.ingredientId,
            schema.ingredientTranslations.language,
          ],
          set: {
            name: sql`excluded.name`,
          },
        });
    }
  });

  console.log("Синхронизация Supercook завершена");
}

export async function logIngredientCountsByLocale(locales) {
  console.log("\n📊 Ingredient counts per language:");
  for (const locale of locales) {
    const result = await db
      .select({ count: sql`COUNT(*)` })
      .from(schema.ingredientTranslations)
      .where(eq(schema.ingredientTranslations.language, locale));

    const count = result[0]?.count || 0;
    console.log(`- ${locale}: ${count} ingredients`);
  }
}
