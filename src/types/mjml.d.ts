declare module 'mjml' {
  interface MjmlResult {
    html: string;
    json: unknown;
    errors: unknown[];
  }
  /** mjml v5 is async: it resolves to the compiled HTML. */
  function mjml2html(mjml: string, options?: Record<string, unknown>): Promise<MjmlResult>;
  export default mjml2html;
}
