import { Menu } from "@tauri-apps/api/menu";

export interface MenuEntry {
  text: string;
  action?: () => void | Promise<void>;
  enabled?: boolean;
  separator?: never;
}

export type MenuSpec = (MenuEntry | { separator: true })[];

/**
 * Pop a real macOS context menu at the pointer. Using the native menu rather
 * than a styled div gets us proper keyboard handling, dismiss-on-blur and the
 * system look for free.
 */
export async function showContextMenu(spec: MenuSpec) {
  const items = spec
    .filter((entry) => !("separator" in entry) || entry.separator)
    .map((entry, i) =>
      "separator" in entry
        ? { item: "Separator" as const }
        : {
            id: `item-${i}`,
            text: entry.text,
            enabled: entry.enabled ?? true,
            action: entry.action,
          },
    );

  const menu = await Menu.new({ items });
  await menu.popup();
}
