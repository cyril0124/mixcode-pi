declare module "fengari" {
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(str: string): Uint8Array;
  export function to_jsstring(str: Uint8Array): string;
}
