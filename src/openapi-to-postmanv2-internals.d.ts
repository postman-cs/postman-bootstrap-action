declare module 'openapi-to-postmanv2/assets/json-schema-faker.js' {
  interface SchemaFakerOptions {
    random: () => number;
  }

  interface SchemaFaker {
    (schema: unknown): unknown;
    option(name: 'random'): () => number;
    option(options: SchemaFakerOptions): unknown;
  }

  const schemaFaker: SchemaFaker;
  export default schemaFaker;
}
