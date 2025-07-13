// syncSupercookRecipes.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import axios from "axios";
import { eq, inArray } from "drizzle-orm";
import dotenv from "dotenv";
dotenv.config();

const POSTGRES_URI = process.env.POSTGRES_URI;
if (!POSTGRES_URI) {
  console.error("❌ POSTGRES_URI не установлена.");
  process.exit(1);
}
const pool = new Pool({ connectionString: POSTGRES_URI });
const db = drizzle(pool, { schema });

const PAGE_SIZE = 61;
const BATCH_SIZE = 100;

async function safePost(url, payload, headers, retries = 5, context = "") {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(url, payload, { headers, timeout: 30000 });
    } catch (error) {
      const isFinal = i === retries - 1;
      const isAbort =
        error.code === "ECONNABORTED" || error.message === "socket hang up";
      const msg = error.message || error.code || "Неизвестная ошибка";

      console.warn(
        `⚠ ${context ? `[${context}] ` : ""}Попытка ${
          i + 1
        } не удалась: ${msg}. Повтор через 3с...`
      );

      if (isFinal || isAbort) {
        console.warn(
          `🚫 ${context}: Запрос окончательно не удался. Пропускаем.`
        );
        return null;
      }

      await new Promise((r) => setTimeout(r, 3000)); // ⏳ пауза 3 сек
    }
  }
}

async function getSupercookRecipesPage(
  ingredients,
  start = 0,
  lang = "ru",
  catname = ""
) {
  const url = "https://d1.supercook.com/dyn/results";
  const payload = new URLSearchParams({
    needsimage: "1",
    app: "1",
    kitchen: ingredients.join(","),
    focus: "exclude",
    kw: "",
    catname: catname,
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

  const response = await safePost(
    url,
    payload,
    headers,
    5,
    `page start=${start}`
  );
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

  const response = await safePost(url, payload, headers, 5, `recipe ID=${rid}`);
  return response.data;
}

async function recipeHasTag(recipeId, tagId, tagItem, tx) {
  if (!recipeId || !tagId || !tagItem) return false;
  let query;
  if (tagItem.type === "meal_type") {
    query = await tx
      .select()
      .from(schema.recipeMealTypes)
      .where(
        eq(schema.recipeMealTypes.recipeId, recipeId),
        eq(schema.recipeMealTypes.mealTypeId, tagId)
      );
  } else if (tagItem.type === "diet") {
    query = await tx
      .select()
      .from(schema.recipeDiets)
      .where(
        eq(schema.recipeDiets.recipeId, recipeId),
        eq(schema.recipeDiets.dietId, tagId)
      );
  } else if (tagItem.type === "kitchen") {
    query = await tx
      .select()
      .from(schema.recipeKitchens)
      .where(
        eq(schema.recipeKitchens.recipeId, recipeId),
        eq(schema.recipeKitchens.kitchenId, tagId)
      );
  }
  return query?.length > 0;
}
async function saveRecipesBatchToDb(recipeDetailsBatch, lang, tagItem = null) {
  if (recipeDetailsBatch.length === 0) return;

  console.log(
    `=== Сохраняем пакет из ${recipeDetailsBatch.length} рецептов ===`
  );

  await db.transaction(async (tx) => {
    // Получаем ID тега в нужной таблице
    let tagId = tagItem?.id || null;

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

    // Собираем все уникальные ингредиенты из пакета
    const allIngredientNames = new Set();
    recipeDetailsBatch.forEach((rd) => {
      rd.ingredients.forEach((ing) => {
        const rawMatch = (ing.m && ing.m[0]) || (ing.raw && ing.raw[0]);
        if (rawMatch) allIngredientNames.add(rawMatch.trim().toLowerCase());
      });
    });

    // Получаем уже существующие ингредиенты из базы
    const existingIngredients = await tx
      .select()
      .from(schema.ingredients)
      .where(eq(schema.ingredients.language, lang));

    const ingredientMap = new Map(
      existingIngredients.map((ing) => [ing.name.trim().toLowerCase(), ing.id])
    );

    // Формируем записи для вставки рецептов
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
          lang: lang,
          imageUrl: recipe.img || null,
          instructions: recipeDetails.instructions || null,
          sourceUrl: recipe.hash || null,
          createdAt: new Date(),
          viewed: 0,
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

    // Формируем связи рецептов с ингредиентами и тегами
    const mealTypeLinks = [];
    const dietLinks = [];
    const kitchenLinks = [];

    for (const recipeDetails of recipeDetailsBatch) {
      const recipe = recipeDetails.recipe;
      const recipeDbId =
        existingRecipeMap.get(recipe.id) || newRecipeIdMap.get(recipe.id);

      if (recipeDbId) {
        // Ингредиенты
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
            line,
            matchedName: normalized,
            ingredientId,
            createdAt: new Date(),
          });
        }

        // Теги по типу
        if (tagId && tagItem) {
          if (tagItem.type === "meal_type") {
            mealTypeLinks.push({ recipeId: recipeDbId, mealTypeId: tagId });
          } else if (tagItem.type === "diet") {
            dietLinks.push({ recipeId: recipeDbId, dietId: tagId });
          } else if (tagItem.type === "kitchen") {
            kitchenLinks.push({ recipeId: recipeDbId, kitchenId: tagId });
          }
        }
      }
    }

    if (recipeIngredientsToInsert.length > 0) {
      await tx
        .insert(schema.recipeIngredients)
        .values(recipeIngredientsToInsert);
    }
    if (mealTypeLinks.length > 0) {
      await tx
        .insert(schema.recipeMealTypes)
        .values(mealTypeLinks)
        .onConflictDoNothing();
    }
    if (dietLinks.length > 0) {
      await tx
        .insert(schema.recipeDiets)
        .values(dietLinks)
        .onConflictDoNothing();
    }
    if (kitchenLinks.length > 0) {
      await tx
        .insert(schema.recipeKitchens)
        .values(kitchenLinks)
        .onConflictDoNothing();
    }

    console.log("✅ Пакет сохранён в базу.");
  });
}

async function linkRecipeWithTag(recipeId, tagId, tagItem, tx) {
  if (!recipeId || !tagId || !tagItem) return;

  const alreadyLinked = await recipeHasTag(recipeId, tagId, tagItem, tx);
  if (alreadyLinked) return;

  if (tagItem.type === "meal_type") {
    await tx
      .insert(schema.recipeMealTypes)
      .values({ recipeId, mealTypeId: tagId })
      .onConflictDoNothing();
  } else if (tagItem.type === "diet") {
    await tx
      .insert(schema.recipeDiets)
      .values({ recipeId, dietId: tagId })
      .onConflictDoNothing();
  } else if (tagItem.type === "kitchen") {
    await tx
      .insert(schema.recipeKitchens)
      .values({ recipeId, kitchenId: tagId })
      .onConflictDoNothing();
  }
}

async function addTagToExistingRecipes(supercookIds, tagItem) {
  if (!tagItem) return;
  await db.transaction(async (tx) => {
    const tagId = tagItem?.id;
    if (!tagId) return;

    const existingRecipes = await tx
      .select({
        id: schema.recipes.id,
        supercookId: schema.recipes.supercookId,
      })
      .from(schema.recipes)
      .where(inArray(schema.recipes.supercookId, supercookIds));

    for (const recipe of existingRecipes) {
      await linkRecipeWithTag(recipe.id, tagId, tagItem, tx);
    }
  });
}

export async function syncSupercookRecipes(
  ingredientsList,
  lang = "ru",
  count = null,
  tagItem = null
) {
  if (!ingredientsList?.length) {
    console.log("Список ингредиентов пуст. Синхронизация невозможна.");
    return;
  }

  let start = 0;
  let recipeDetailsBuffer = [];
  const failedRecipeIds = [];
  let successCount = 0;
  let skippedCount = 0;
  let failPageCount = 0;

  while (true) {
    if (count !== null && successCount >= count) {
      console.log(
        `Достигнут лимит по количеству сохранённых рецептов: ${count}`
      );
      break;
    }

    console.log(`--- Загружаем страницу рецептов start=${start} ---`);
    const recipesPage = await getSupercookRecipesPage(
      ingredientsList,
      start,
      lang,
      tagItem?.tag || ""
    );

    if (!recipesPage) {
      failPageCount++;
      console.warn(
        `🚫 Ошибка загрузки страницы start=${start} (failPageCount=${failPageCount})`
      );

      if (failPageCount >= 3) {
        console.warn(
          `⏳ Три страницы подряд не загрузились. Ждём 30 секунд...`
        );
        await new Promise((r) => setTimeout(r, 30000));
        failPageCount = 0;
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }

      start += PAGE_SIZE;
      continue;
    } else {
      failPageCount = 0; // сброс счётчика после успешной страницы
    }

    const supercookIdsOnPage = recipesPage.map((r) => r.id);
    const existingRecipesOnPage = await db
      .select({ supercookId: schema.recipes.supercookId })
      .from(schema.recipes)
      .where(inArray(schema.recipes.supercookId, supercookIdsOnPage));

    const existingSupercookIdsSet = new Set(
      existingRecipesOnPage.map((r) => r.supercookId)
    );

    const existingIds = Array.from(existingSupercookIdsSet);
    if (existingIds.length > 0 && tagItem) {
      await addTagToExistingRecipes(existingIds, tagItem);
    }

    for (const [i, recipeSummary] of recipesPage.entries()) {
      if (count !== null && successCount >= count) break;

      const rid = recipeSummary.id;

      if (existingSupercookIdsSet.has(rid)) {
        console.log(`↪ Рецепт ID=${rid} уже есть. Пропущен.`);
        skippedCount++;
        continue;
      }

      try {
        console.log(
          `Получаем детали рецепта ID=${rid} (${i + 1}/${recipesPage.length})`
        );
        const recipeDetails = await getRecipeDetails(rid, lang);

        if (!recipeDetails?.recipe) {
          console.warn(`⚠ Нет данных для рецепта ID=${rid}`);
          continue;
        }

        recipeDetailsBuffer.push(recipeDetails);
        successCount++;

        if (recipeDetailsBuffer.length >= BATCH_SIZE) {
          await saveRecipesBatchToDb(recipeDetailsBuffer, lang, tagItem);
          console.log(
            `💾 Сохранили и очистили буфер из ${recipeDetailsBuffer.length} рецептов`
          );
          recipeDetailsBuffer = [];
        }
      } catch (error) {
        console.warn(`❌ Ошибка при получении ID=${rid}: ${error.message}`);
        failedRecipeIds.push(rid);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (recipesPage.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  if (recipeDetailsBuffer.length > 0) {
    await saveRecipesBatchToDb(recipeDetailsBuffer, lang, tagItem);
    console.log(`💾 Финально сохранили ${recipeDetailsBuffer.length} рецептов`);
    recipeDetailsBuffer = [];
  }
  // Повторная попытка загрузки упавших рецептов с учётом лимита
  if (failedRecipeIds.length > 0) {
    console.log(
      `🔄 Повторная попытка для ${failedRecipeIds.length} упавших рецептов...`
    );
    const retryBuffer = [];

    for (const rid of failedRecipeIds) {
      if (count !== null && successCount >= count) {
        console.log(
          `Достигнут лимит по количеству сохранённых рецептов: ${count}`
        );
        break;
      }

      try {
        const recipeDetails = await getRecipeDetails(rid, lang);
        if (!recipeDetails?.recipe) continue;

        retryBuffer.push(recipeDetails);
        successCount++;
      } catch (error) {
        console.warn(`⛔ Повторная ошибка рецепта ID=${rid}: ${error.message}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (retryBuffer.length > 0) {
      await saveRecipesBatchToDb(retryBuffer, lang, tagItem);
      console.log(
        `💾 Повторно сохранено ${retryBuffer.length} рецептов после сбоев`
      );
    }
  }

  const failedFinalCount = failedRecipeIds.length - successCount + skippedCount;

  console.log("📊 Статистика синхронизации:");
  console.log(`✅ Успешно загружено: ${successCount}`);
  console.log(`↪ Пропущено (уже в БД): ${skippedCount}`);
  console.log(`❌ Не удалось загрузить: ${Math.max(failedFinalCount, 0)}`);
  console.log("🎉 Синхронизация Supercook завершена");
}
