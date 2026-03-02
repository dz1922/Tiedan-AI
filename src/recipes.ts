/**
 * Family recipe management module
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'recipes.json');

interface Recipe {
  name: string;
  ingredients: string[];
  steps: string[];
  category: string;
  tags: string[];
  createdAt?: string;
  updatedAt: string;
}

function loadRecipes(): Recipe[] {
  if (!existsSync(DATA_FILE)) return [];
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf-8')); } catch { return []; }
}

function saveRecipes(recipes: Recipe[]): void {
  writeFileSync(DATA_FILE, JSON.stringify(recipes, null, 2), 'utf-8');
}

export function getRecipeSuggestion(people = 5, preferences: string[] = []) {
  const recipes = loadRecipes();
  if (recipes.length === 0) return { suggestion: 'Recipe book is empty! Add some recipes first.', recipes: [] };

  const dishCount = Math.max(2, Math.ceil(people / 2) + 1);
  const shuffled = [...recipes].sort(() => Math.random() - 0.5);

  let filtered = shuffled;
  if (preferences.length > 0) {
    const pf = shuffled.filter(r => {
      const tags = (r.category || '') + ' ' + (r.tags || []).join(' ');
      return preferences.some(p => tags.includes(p));
    });
    if (pf.length > 0) filtered = pf;
  }

  const selected = filtered.slice(0, dishCount);
  return { suggestion: `${people} people, recommending ${selected.length} dishes`, recipes: selected };
}

export function saveRecipe(name: string, ingredients: string[], steps: string[], category = 'home-style', tags: string[] = []): Recipe {
  const recipes = loadRecipes();
  const existing = recipes.findIndex(r => r.name === name);
  const recipe: Recipe = { name, ingredients, steps, category, tags, updatedAt: new Date().toISOString() };

  if (existing >= 0) {
    recipes[existing] = { ...recipes[existing], ...recipe };
  } else {
    recipe.createdAt = recipe.updatedAt;
    recipes.push(recipe);
  }
  saveRecipes(recipes);
  return recipe;
}

export function listRecipes(category?: string): Recipe[] {
  const recipes = loadRecipes();
  return category ? recipes.filter(r => r.category === category) : recipes;
}

export function deleteRecipe(name: string): boolean {
  const recipes = loadRecipes();
  const idx = recipes.findIndex(r => r.name === name);
  if (idx < 0) return false;
  recipes.splice(idx, 1);
  saveRecipes(recipes);
  return true;
}
