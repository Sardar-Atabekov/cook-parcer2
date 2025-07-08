import { Pool } from "pg";
import {
  syncSupercookIngredients,
  getIngredientsByLanguage,
  logIngredientCountsByLocale,
} from "./ingridients.js";
import { syncSupercookRecipes } from "./recipe_parser.js";
const POSTGRES_URI =
  "postgresql://postgres:GXZEoCNdFehOoXqXVFeJCQLGIjlZCwsu@maglev.proxy.rlwy.net:42374/railway";

const pool = new Pool({
  connectionString: POSTGRES_URI,
});

async function main() {
  const locales = ["de", "ar", "fr", "en", "zh", "ru", "es"];
  try {
    // for (const locale of locales) {
    //   console.log(`Syncing for locale: ${locale}`);
    //   await syncSupercookIngredients(locale);
    // }
    console.log("Data import process finished.");
    await logIngredientCountsByLocale(locales);
    for (const locale of locales) {
      let ingredients = await getIngredientsByLanguage(locale);
      console.log("ingredients", ingredients.length);
      await syncSupercookRecipes(ingredients, locale);
      console.log("🎉 Импорт рецептов завершён.");
    }
  } catch (error) {
    console.error("An error occurred during the data import process:", error);
  } finally {
    await pool.end();
  }
}

main();
