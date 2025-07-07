import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import axios from "axios";
import { eq, inArray } from "drizzle-orm";

const POSTGRES_URI =
  "postgresql://postgres:GXZEoCNdFehOoXqXVFeJCQLGIjlZCwsu@maglev.proxy.rlwy.net:42374/railway";

const pool = new Pool({ connectionString: POSTGRES_URI });
const db = drizzle(pool, { schema });

const PAGE_SIZE = 61;
const BATCH_SIZE = 100; // Define a batch size for inserts

async function safePost(url, payload, headers, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(url, payload, { headers, timeout: 30000 });
    } catch (error) {
      const isFinal = i === retries - 1;
      const isAbort =
        error.code === "ECONNABORTED" || error.message === "socket hang up";
      if (isFinal || isAbort) throw error;
      console.warn(`Попытка ${i + 1} не удалась, повтор через 1с...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function getSupercookRecipesPage(ingredients, start = 0, lang = "ru") {
  const url = "https://d1.supercook.com/dyn/results";
  const payload = new URLSearchParams({
    needsimage: "1",
    app: "1",
    kitchen: ingredients.join(","),
    focus: "exclude",
    kw: "",
    catname: "",
    start: start.toString(),
    fave: "false",
    lh: "cd9408d6f5f314c68d2697a18761da142b47645c",
    lang: lang,
    cv: "2",
  }).toString();

  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://www.supercook.com",
    Referer: "https://www.supercook.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };

  const response = await safePost(url, payload, headers);
  return response.data.results;
}

async function getRecipeDetails(rid, lang = "ru") {
  const url = "https://d1.supercook.com/dyn/details";
  const payload = new URLSearchParams({ rid, lang }).toString();

  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://www.supercook.com",
    Referer: "https://www.supercook.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };

  const response = await safePost(url, payload, headers);
  return response.data;
}

async function saveRecipesBatchToDb(recipeDetailsBatch) {
  if (recipeDetailsBatch.length === 0) return;

  await db.transaction(async (tx) => {
    const supercookIds = recipeDetailsBatch.map((rd) => rd.recipe.id);
    const existingRecipes = await tx
      .select({
        supercookId: schema.recipes.supercookId,
        id: schema.recipes.id,
      })
      .from(schema.recipes)
      .where(inArray(schema.recipes.supercookId, supercookIds));

    const existingRecipeMap = new Map(
      existingRecipes.map((r) => [r.supercookId, r.id])
    );

    const recipesToInsert = [];
    const recipeIngredientsToInsert = [];

    const allIngredientNames = new Set();
    recipeDetailsBatch.forEach((rd) => {
      rd.ingredients.forEach((ing) => {
        const rawMatch = (ing.m && ing.m[0]) || (ing.raw && ing.raw[0]);
        if (rawMatch) allIngredientNames.add(rawMatch.trim().toLowerCase());
      });
    });

    const existingIngredients = await tx.select().from(schema.ingredients);
    const ingredientMap = new Map(
      existingIngredients.map((ing) => [ing.primaryName.toLowerCase(), ing.id])
    );

    for (const recipeDetails of recipeDetailsBatch) {
      const recipe = recipeDetails.recipe;
      let recipeDbId = existingRecipeMap.get(recipe.id);

      if (!recipeDbId) {
        recipesToInsert.push({
          supercookId: recipe.id,
          title: recipe.title,
          description: recipe.desc || null,
          prepTime: recipeDetails.attribs?.time_in_minutes || null,
          rating: recipeDetails.attribs?.rating || null,
          difficulty: null,
          imageUrl: recipe.img || null,
          instructions: recipeDetails.instructions || null,
          sourceUrl: recipe.hash || null,
          createdAt: new Date(),
        });
      }
    }

    let insertedRecipes = [];
    if (recipesToInsert.length > 0) {
      insertedRecipes = await tx
        .insert(schema.recipes)
        .values(recipesToInsert)
        .returning({
          id: schema.recipes.id,
          supercookId: schema.recipes.supercookId,
        });
    }

    const newRecipeIdMap = new Map(
      insertedRecipes.map((r) => [r.supercookId, r.id])
    );

    for (const recipeDetails of recipeDetailsBatch) {
      const recipe = recipeDetails.recipe;
      let recipeDbId =
        existingRecipeMap.get(recipe.id) || newRecipeIdMap.get(recipe.id);

      if (recipeDbId) {
        for (const ingredientObj of recipeDetails.ingredients) {
          const line = ingredientObj.line?.trim();
          if (!line) continue;

          const rawMatch =
            (ingredientObj.m && ingredientObj.m[0]) ||
            (ingredientObj.raw && ingredientObj.raw[0]);
          const normalized = rawMatch?.trim().toLowerCase() || null;
          const ingredientId = normalized
            ? ingredientMap.get(normalized) || null
            : null;

          recipeIngredientsToInsert.push({
            recipeId: recipeDbId,
            line: line,
            matchedName: normalized,
            ingredientId: ingredientId,
            createdAt: new Date(),
          });
        }
      }
    }

    if (recipeIngredientsToInsert.length > 0) {
      await tx
        .insert(schema.recipeIngredients)
        .values(recipeIngredientsToInsert);
    }
  });
}

export async function syncSupercookRecipes(ingredientsList, lang = "ru") {
  if (!ingredientsList?.length) {
    console.log("Список ингредиентов пуст. Синхронизация невозможна.");
    return;
  }

  let start = 0;
  let recipeDetailsBuffer = [];

  while (true) {
    console.log(`Загружаем страницу рецептов с start=${start}...`);
    const recipesPage = await getSupercookRecipesPage(
      ingredientsList,
      start,
      lang
    );
    if (!Array.isArray(recipesPage) || recipesPage.length === 0) break;

    const supercookIdsOnPage = recipesPage.map((r) => r.id);
    const existingRecipesOnPage = await db
      .select({ supercookId: schema.recipes.supercookId })
      .from(schema.recipes)
      .where(inArray(schema.recipes.supercookId, supercookIdsOnPage));

    const existingSupercookIdsSet = new Set(
      existingRecipesOnPage.map((r) => r.supercookId)
    );

    for (const recipeSummary of recipesPage) {
      const rid = recipeSummary.id;
      if (existingSupercookIdsSet.has(rid)) {
        console.log(`Рецепт с Supercook ID=${rid} уже есть. Пропускаем.`);
        continue;
      }

      try {
        console.log(`Получаем детали рецепта ID=${rid}...`);
        const recipeDetails = await getRecipeDetails(rid, lang);

        if (!recipeDetails?.recipe) {
          console.warn(`Нет данных для рецепта title ${recipe.title}`);
          continue;
        }
        recipeDetailsBuffer.push(recipeDetails);

        if (recipeDetailsBuffer.length >= BATCH_SIZE) {
          console.log(
            `Сохраняем пакет из ${recipeDetailsBuffer.length} рецептов в БД...`
          );
          await saveRecipesBatchToDb(recipeDetailsBuffer);
          recipeDetailsBuffer = [];
        }
      } catch (error) {
        console.error(`Ошибка при обработке рецепта ID=${rid}:`, error.message);
      }
    }

    if (recipesPage.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  // Save any remaining recipes in the buffer
  if (recipeDetailsBuffer.length > 0) {
    console.log(
      `Сохраняем оставшиеся ${recipeDetailsBuffer.length} рецептов в БД...`
    );
    await saveRecipesBatchToDb(recipeDetailsBuffer);
  }

  console.log("✅ Синхронизация рецептов Supercook завершена");
}
