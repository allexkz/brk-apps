// Hook de resolução p/ rodar os módulos do app em node puro no teste: anexa ".js" a
// imports relativos sem extensão (o bundler do Vite faz isso; o node ESM não).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.(m|c)?js$/.test(specifier)) {
    const candidate = new URL(specifier + ".js", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
