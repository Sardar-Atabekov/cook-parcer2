import { Pool } from "pg";
import {
  syncSupercookIngredients,
  getIngredientsByLanguage,
} from "./ingridients.js";
import { syncSupercookRecipes } from "./recipe_parser.js";
import * as schema from "./schema.js";
import { drizzle } from "drizzle-orm/node-postgres";
import dotenv from "dotenv";

dotenv.config();

const POSTGRES_URI = process.env.POSTGRES_URI;
if (!POSTGRES_URI) {
  console.error("❌ POSTGRES_URI не установлена.");
  process.exit(1);
}
const locales = process.env.LOCALES.split(",");
const pool = new Pool({ connectionString: POSTGRES_URI });
const db = drizzle(pool, { schema });

async function main() {

  const mealTypes = await db.select().from(schema.mealTypes);
  const dieta = await db.select().from(schema.diets);
  const kitchen = await db.select().from(schema.kitchens);
  try {
    // for (const locale of locales) {
    //   console.log(`Syncing for locale: ${locale}`);
    //   await syncSupercookIngredients(locale);
    // }
    for (const locale of locales) {
      await syncSupercookIngredients(locale);
      const ingredients = await getIngredientsByLanguage(locale);
      console.log("📥 Ingredients for locale:", locale, ingredients.length);

      const allTags = [...kitchen, ...mealTypes, ...dieta];

      for (const tagItem of allTags) {
        console.log(
          `🌍 Syncing ${tagItem.type} "${tagItem.name}" [${tagItem.tag}] for locale: ${locale}`
        );
        console.log(`🌍 Syncing tagItem`);
        await syncSupercookRecipes(ingredients, locale, null, tagItem);
      }
      await syncSupercookRecipes(ingredients, locale);

      console.log("✅ Импорт рецептов для локали завершён:", locale);
    }

    console.log("🎉 Все локали обработаны.");
  } catch (error) {
    console.error("❌ Ошибка при импорте данных:", error);
  } finally {
    await pool.end();
  }
}

main();
