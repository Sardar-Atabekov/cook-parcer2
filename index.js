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
  try {
    for (const locale of locales) {
      await syncSupercookIngredients(locale);
      const ingredients = await getIngredientsByLanguage(locale);
      console.log("📥 Ingredients for locale:", locale, ingredients.length);

      for (const ingredient of ingredients) {
        console.log(
          `🌍 Syncing ingredient "${ingredient}" for locale: ${locale}`
        );
        await syncSupercookRecipes([ingredient], locale, 30);
        console.log(`✅ Импорт рецептов для ${ingredient} завершён:`, locale);
      }
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
