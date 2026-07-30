declare module 'postman-collection/lib/superstring/dynamic-variables' {
  interface DynamicVariableDefinition {
    description?: string;
    generator?: () => unknown;
  }

  const dynamicVariables: Record<string, DynamicVariableDefinition>;
  export = dynamicVariables;
}
