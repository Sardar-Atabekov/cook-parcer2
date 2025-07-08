import { pgTable, serial, integer, text, boolean, timestamp, jsonb, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

export const ingredientCategories = pgTable(
  'ingredient_categories',
  {
    id: serial('id').primaryKey(),
    parentId: integer('parent_id'),
    level: integer('level').default(0),
    sortOrder: integer('sort_order').default(0),
    isActive: boolean('is_active').default(true),
    icon: text('icon'), // Re-added icon field
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  }
);

export const ingredientCategoryTranslations = pgTable(
  'ingredient_category_translations',
  {
    id: serial('id').primaryKey(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => ingredientCategories.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    name: text('name').notNull(),
    description: text('description'),
  },
  (table) => ({
    unq: uniqueIndex('category_language_unq').on(table.categoryId, table.language),
  })
);

export const ingredients = pgTable('ingredients', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').references(() => ingredientCategories.id, { onDelete: 'cascade' }),
  primaryName: text('primary_name').notNull(),
  isActive: boolean('is_active').default(true),
  aliases: jsonb('aliases'),
  nutritionalData: jsonb('nutritional_data'),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const ingredientTranslations = pgTable('ingredient_translations', {
  id: serial('id').primaryKey(),
  ingredientId: integer('ingredient_id')
    .notNull()
    .references(() => ingredients.id, { onDelete: 'cascade' }),
  language: text('language').notNull(),
  name: text('name').notNull(),
},
(table) => ({
  unq: uniqueIndex('ingredient_language_unq').on(table.ingredientId, table.language),
}));


export const recipes = pgTable('recipes', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  prepTime: integer('prep_time'),
  rating: integer('rating'),
  difficulty: text('difficulty'),
  imageUrl: text('image_url'),
  lang: text('lang'),
  instructions: jsonb('instructions'),
  sourceUrl: text('source_url'),
  supercookId: text("supercook_id").notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
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

export const recipeIngredients = pgTable('recipe_ingredients', {
   id: serial('id').primaryKey(),
  recipeId: integer('recipe_id')
    .notNull()
    .references(() => recipes.id),
  line: text('line').notNull(),
  matchedName: text('matched_name'),
  ingredientId: integer('ingredient_id').references(() => ingredients.id), // может быть null
  createdAt: timestamp('created_at').defaultNow(),
});
