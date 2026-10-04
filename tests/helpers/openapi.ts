// Walkers for OpenAPI documents (M8): the structural invariants are tested without a validator dependency (ADR-025).

/** Every `$ref` string anywhere in `node`, depth-first, in document order. */
export const collectRefs = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(collectRefs);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === '$ref' && typeof value === 'string' ? [value] : collectRefs(value),
  );
};

/** The node a local JSON pointer (`#/components/schemas/User`) names in `document`, or undefined if there is none. */
export const resolvePointer = (document: unknown, pointer: string): unknown => {
  if (!pointer.startsWith('#/')) return undefined;
  return pointer
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (node, segment) =>
        node !== null && typeof node === 'object' && Object.hasOwn(node, segment)
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      document,
    );
};

/** The `{param}` names of an OpenAPI path template, in order: `/api/search/{collection}/{term}` → collection, term. */
export const pathParams = (template: string): string[] =>
  [...template.matchAll(/\{([^}]+)\}/g)].flatMap(([, name]) => (name ? [name] : []));
