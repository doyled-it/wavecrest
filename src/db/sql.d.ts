// Tell TypeScript that .sql files imported with `with { type: "text" }` yield a string.
declare module "*.sql" {
  const content: string;
  export default content;
}
