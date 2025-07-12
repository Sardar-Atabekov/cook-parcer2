import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  numeric,
} from "drizzle-orm/pg-core";

export const ingredientCategories = pgTable(
  "ingredient_categories",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id"),
    level: integer("level").default(0),
    sortOrder: integer("sort_order").default(0),
    isActive: boolean("is_active").default(true),
    icon: text("icon").notNull(), // обязательный и уникальный
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    unq_icon: uniqueIndex("unique_category_icon").on(table.icon),
  })
);

export const ingredientCategoryTranslations = pgTable(
  "ingredient_category_translations",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => ingredientCategories.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    name: text("name").notNull(),
    description: text("description"),
  },
  (table) => ({
    unq: uniqueIndex("category_language_unq").on(
      table.categoryId,
      table.language
    ),
  })
);

export const ingredients = pgTable(
  "ingredients",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    isActive: boolean("is_active").default(true),
    aliases: jsonb("aliases"),
    nutritionalData: jsonb("nutritional_data"),
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    unq_name_lang: uniqueIndex("unique_ingredient_name_lang").on(
      table.name,
      table.language
    ),
  })
);

export const ingredientCategoryLinks = pgTable(
  "ingredient_category_links",
  {
    id: serial("id").primaryKey(),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => ingredientCategories.id, { onDelete: "cascade" }),
  },
  (table) => ({
    unq_ingredient_category: uniqueIndex("unique_ingredient_category").on(
      table.ingredientId,
      table.categoryId
    ),
  })
);

export const recipes = pgTable("recipes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  prepTime: numeric("prep_time"),
  rating: integer("rating"),
  difficulty: text("difficulty"),
  imageUrl: text("image_url"),
  instructions: jsonb("instructions"),
  lang: text("lang"),
  sourceUrl: text("source_url"),
  supercookId: text("supercook_id").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const mealTypes = pgTable('meal_types', {
  id: serial('id').primaryKey(),
  tag: text('tag').notNull().unique(), // оригинальный tag с сайта
  slug: text('slug').notNull().unique(), // для фильтрации
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const diets = pgTable('diets', {
  id: serial('id').primaryKey(),
  tag: text('tag').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const kitchens = pgTable('kitchens', {
  id: serial('id').primaryKey(),
  tag: text('tag').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});


export const recipeMealTypes = pgTable("recipe_meal_types", {
  recipeId: integer("recipe_id").references(() => recipes.id),
  mealTypeId: integer("meal_type_id").references(() => mealTypes.id),
});

export const recipeDiets = pgTable("recipe_diets", {
  recipeId: integer("recipe_id").references(() => recipes.id),
  dietId: integer("diet_id").references(() => diets.id),
});

export const recipeKitchens = pgTable("recipe_kitchens", {
  recipeId: integer("recipe_id").references(() => recipes.id),
  kitchenId: integer("kitchen_id").references(() => kitchens.id),
});

// export const ingredients = pgTable('ingredients', {
//   id: serial('id').primaryKey(),
//   primaryName: text('primary_name').notNull().unique(),
//   categoryId: integer('category_id'),
//   isActive: boolean('is_active').default(true),
//   createdAt: timestamp('created_at').defaultNow(),
//   updatedAt: timestamp('updated_at').defaultNow(),
//   lastSyncAt: timestamp('last_sync_at').defaultNow(),
// });

// export const ingredientCategories = pgTable('ingredient_categories', {
//   id: serial('id').primaryKey(),
//   parentId: integer('parent_id'),
//   level: integer('level').notNull(),
//   sortOrder: integer('sort_order').notNull(),
//   isActive: boolean('is_active').default(true),
//   icon: text('icon'),
//   createdAt: timestamp('created_at').defaultNow(),
//   updatedAt: timestamp('updated_at').defaultNow(),
// });

// export const ingredientCategoryTranslations = pgTable('ingredient_category_translations', {
//   id: serial('id').primaryKey(),
//   categoryId: integer('category_id').references(() => ingredientCategories.id).notNull(),
//   language: text('language').notNull(),
//   name: text('name').notNull(),
//   description: text('description'),
// });

// export const ingredientTranslations = pgTable('ingredient_translations', {
//   id: serial('id').primaryKey(),
//   ingredientId: integer('ingredient_id').references(() => ingredients.id).notNull(),
//   language: text('language').notNull(),
//   name: text('name').notNull(),
// });

export const recipeIngredients = pgTable("recipe_ingredients", {
  id: serial("id").primaryKey(),
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id),
  line: text("line").notNull(),
  matchedName: text("matched_name"),
  ingredientId: integer("ingredient_id").references(() => ingredients.id), // может быть null
  createdAt: timestamp("created_at").defaultNow(),
});
