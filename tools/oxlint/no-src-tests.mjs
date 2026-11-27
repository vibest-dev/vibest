export const noSrcTests = {
  create(context) {
    const file = context.filename.replaceAll("\\", "/")

    if (!/\/packages\/[^/]+\/src\/.*\.test\.[cm]?[jt]sx?$/.test(file)) return {}

    return {
      Program(node) {
        context.report({
          node,
          message: "Test files belong under packages/<pkg>/test/, not packages/<pkg>/src/.",
        })
      },
    }
  },
}
