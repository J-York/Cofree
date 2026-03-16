/**
 * Cofree - AI Programming Cafe
 * File: src/vite-env.d.ts
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Vite ambient type declarations.
 */

/// <reference types="vite/client" />

declare module "react-syntax-highlighter" {
  import type { ComponentType } from "react";
  export const Prism: ComponentType<Record<string, unknown>>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-dark" {
  const style: Record<string, unknown>;
  export default style;
}
