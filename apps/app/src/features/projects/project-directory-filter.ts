export interface ProjectDirectoryEntry {
  value: string;
  label: string;
  kind: "up" | "dir";
}

const withoutTrailingSeparators = (value: string) => value.replace(/[\\/]+$/, "");

const isExactPathSearch = (entry: ProjectDirectoryEntry, search: string): boolean =>
  withoutTrailingSeparators(entry.value) === withoutTrailingSeparators(search);

export const isProjectDirectoryEntryVisible = (
  entry: ProjectDirectoryEntry,
  search: string,
): boolean =>
  entry.kind !== "dir" ||
  !entry.label.startsWith(".") ||
  search.startsWith(".") ||
  isExactPathSearch(entry, search);

export const projectDirectoryEntryMatches = (entry: unknown, search: string): boolean => {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("label" in entry) ||
    typeof entry.label !== "string" ||
    !("value" in entry) ||
    typeof entry.value !== "string"
  ) {
    return false;
  }

  const query = withoutTrailingSeparators(search).toLocaleLowerCase();
  if (query.length === 0) return true;

  return (
    entry.label.toLocaleLowerCase().includes(query) ||
    withoutTrailingSeparators(entry.value).toLocaleLowerCase().includes(query)
  );
};
