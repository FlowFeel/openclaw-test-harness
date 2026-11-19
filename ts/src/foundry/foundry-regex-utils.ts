/**
 * Foundry Regex Utilities — centralized, frozen regex patterns for the DFT validator
 * and plugin scaffolder.
 *
 * @invariants
 * - Zero inline regexes in foundry check modules.
 * - Global (/g) regexes are returned from factory functions to avoid lastIndex state leaks.
 *
 * @dft
 * - Pure pattern constants/factories; exercised via validate-logic.spec.ts and scaffold.spec.ts.
 */

export function importStatementGlobal(): RegExp {
  return /^\s*(?:import|export)\s+[^;]*?from\s+["']([^"']+)["'];?/gm;
}

export function relativeImportGlobal(): RegExp {
  return /from\s+["'](\.[^"']+)["']/g;
}

export function registerToolGlobal(): RegExp {
  return /registerTool\s*\(\s*\{[^}]*?name\s*:\s*["']([^"']+)["']/gs;
}

export function registerHookGlobal(): RegExp {
  return /(?:registerHook|api\.on)\s*\(\s*(?:["']([^"']+)["']|\[([^\]]*)\])/g;
}

export function quotedStringGlobal(): RegExp {
  return /["']([^"']+)["']/g;
}

export const BLOCK_COMMENT_GLOBAL = (): RegExp => /\/\*[\s\S]*?\*\//g;
export const LINE_COMMENT_PREFIX = Object.freeze(/^\s*\/\//);
export const DFT_TAG_REGEX = Object.freeze(/@dft/);
export const INVARIANTS_TAG_REGEX = Object.freeze(/@invariants/);

export const DATE_NOW_REGEX = Object.freeze(/\bDate\.now\s*\(/);
export const MATH_RANDOM_REGEX = Object.freeze(/\bMath\.random\s*\(/);
export const NEW_DATE_REGEX = Object.freeze(/\bnew\s+Date\s*\(/);

export function viFnCallGlobal(): RegExp {
  return /\bvi\.fn\s*\(/g;
}

export function viMockCallGlobal(): RegExp {
  return /\bvi\.mock\s*\(/g;
}

export const REAL_DOUBLE_CLASS_REGEX = Object.freeze(/\bclass\s+\w+\s+implements\b/);
export const REAL_DOUBLE_CONST_REGEX = Object.freeze(
  /const\s+\w+\s*:\s*\w*(Reader|Writer|Store|Pool|Server|Client|Api|Fetcher|Loader|Spawner)\b/,
);

export const MUTATING_VERBS_REGEX = Object.freeze(
  /^(cleanup|purge|strip|apply|execute|run|process|flush|evict|remove|delete|clear|add|put|set|register|unregister|reset)/i,
);

export function exportedVoidFnGlobal(): RegExp {
  return /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*:\s*void\s*\{/g;
}

export function emptyCatchGlobal(): RegExp {
  return /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/g;
}

export function typeErasureGlobal(): RegExp {
  return /(?::\s*any\b|\bas\s+any\b|\bas\s+never\b|<any>)/g;
}

export const INLINE_REGEX_METHOD_CALL = Object.freeze(
  /(\.replace|\.match|\.split|\.test|\.search)\s*\(\s*(\/[^/\n]+\/[gimsuy]*)/,
);

export const INLINE_REGEX_LITERAL_EXEC = Object.freeze(
  /(\/[^/\n]+\/[gimsuy]*)\s*\.(test|exec)\(/,
);

export const FUNCTION_DECL_REGEX = Object.freeze(
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
);

export const KEBAB_OR_SNAKE_SPLIT = Object.freeze(/[-_]/);
export function kebabOrSnakeGlobal(): RegExp {
  return /[-_]/g;
}
