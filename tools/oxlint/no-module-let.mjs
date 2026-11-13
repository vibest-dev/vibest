export const noModuleLet = {
  create(context) {
    const report = (node) =>
      context.report({
        node,
        message: "No module-level let: keep mutable state in the service, client or test scope that owns its lifetime.",
      })
    return {
      VariableDeclaration(node) {
        if (node.kind === "let" && (node.parent.type === "Program" || node.parent.type === "ExportNamedDeclaration"))
          report(node)
      },
    }
  },
}
