import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface MenuEntry {
  text: string;
  action?: () => void | Promise<void>;
  enabled?: boolean;
  /** Present (true or false) makes it a native check item. */
  checked?: boolean;
  /** Present makes it a submenu; `action` is then ignored. */
  items?: MenuSpec;
  separator?: never;
}

export type MenuSpec = (MenuEntry | { separator: true })[];

// The options Tauri expects, built recursively; typed loosely because the
// item, check item and submenu shapes are told apart by their keys.
type NativeItem = Record<string, unknown>;

function toNative(spec: MenuSpec, path: string): NativeItem[] {
  return spec.map((entry, i) => {
    if ("separator" in entry && entry.separator) return { item: "Separator" };
    const e = entry as MenuEntry;
    const id = `${path}-${i}`;
    if (e.items) {
      return { id, text: e.text, enabled: e.enabled ?? true, items: toNative(e.items, id) };
    }
    return {
      id,
      text: e.text,
      enabled: e.enabled ?? true,
      action: e.action,
      ...(e.checked !== undefined ? { checked: e.checked } : {}),
    };
  });
}

/**
 * Pop a real macOS menu. Using the native menu rather than a styled div gets
 * us proper keyboard handling, dismiss-on-blur and the system look for free.
 *
 * Without `anchor` it opens at the pointer (context menu); with one, it drops
 * down from that element's bottom-left corner, like a button's menu.
 */
export async function showContextMenu(spec: MenuSpec, anchor?: Element | null) {
  const menu = await Menu.new({ items: toNative(spec, "item") as never });
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
  } else {
    await menu.popup();
  }
}
