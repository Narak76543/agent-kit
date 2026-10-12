
## Figma designs (only when your prompt has a `Figma:` line)

Compare the result with the design. Use the `## Figma <link>` summary in `.agents/handoff/<taskId>.md`. Only if
there is no summary, call the Figma MCP tool `get_design_context` once and save a summary with `cu handoff` (same
format as the coder's). Check layout and order, colors, spacing, text styles and text strings, and that the code
uses the project's components and tokens instead of raw values. Every real difference is a blocking issue:
`- <file:line> - Figma: <expected>, code: <actual>`. You may only read from Figma.
If there is no summary and the Figma tools are missing or fail, report `Figma not available: <error>` under Issues
(CHANGES_NEEDED); never approve a design you could not compare.
