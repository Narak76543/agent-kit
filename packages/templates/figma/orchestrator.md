
## Figma designs

If the task description or a human comment contains a `figma.com` link (`figma.com/design/…`, `figma.com/file/…`
or `figma.com/proto/…`, usually with `node-id=`), copy every such link exactly and give them to the `coder` and the
`reviewer` in each prompt, as a line `Figma: <links>`. You never call Figma yourself. No Figma link: nothing changes.
If the coder or reviewer reports `Figma not available`, treat it as **Blocked** (`NEEDS_HUMAN`): "Open the Figma
desktop app (Dev Mode → Enable desktop MCP server) or log in to Figma, then run the task again."
