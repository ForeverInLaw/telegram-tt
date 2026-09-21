# Writing plugins

Plugins are first-party TypeScript folders that extend the client through the `tg` object. This README is the contract documentation for plugin authors: the plugin shape and lifecycle, every surface of `tg`, and the policy that keeps plugins compiling across releases.

The types in [`types.ts`](./types.ts) are the contract — this document explains them, never replaces them. The bundled plugins are the reference implementations:

| Plugin | Shows |
| --- | --- |
| [`hello-plugin`](./hello-plugin/index.ts) | The showcase — one minimal use of every surface (this README's examples point into it) |
| [`echo-plugin`](./echo-plugin/index.ts) | `tg.api` + `tg.store` + `tg.util` combined in one action |
| [`ui-demo-plugin`](./ui-demo-plugin/index.ts) | Every `tg.ui` surface with a notification response |

A plugin module never imports from `src/global` or `src/api` — only the reverse direction (app code importing from `src/plugins`) is legal, enforced by convention. Everything a plugin may call arrives in `setup(tg)`; types and helpers come from [`types.ts`](./types.ts) only.

## Plugin shape & discovery

A plugin is a folder under `src/plugins/` with an `index.ts` that default-exports a `TgPlugin`:

```ts
// src/plugins/my-plugin/index.ts
import { definePlugin } from '../types';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Shown under the plugin name in Settings → Plugins.',
  setup(tg) {
    // register contributions and subscriptions here
  },
});
```

- `name` (required) — the unique registry key. The host skips a module whose name is already registered, and the enable/disable persistence keys off the name, so keep it stable.
- `version?`, `description?` — plain data shown on the Settings → Plugins screen.
- `setup` (required) — receives the `tg` object; described next.

There is no registration step. The host ([`host.ts`](./host.ts)) globs `src/plugins/*/index.ts` and loads every valid default export at app startup, before the app boots. The dev bundler hot-reloads a changed plugin module. A module without a valid `TgPlugin` default export (or with a duplicate name) is logged and skipped — it never breaks the client.

## Lifecycle

`setup(tg)` runs at startup when the plugin is enabled. It may return a disposer:

```ts
setup(tg) {
  const unsubscribe = tg.on('message:new', handle);

  return () => {
    unsubscribe(); // plugin-owned cleanup
  };
}
```

- **Disposer.** Called when the plugin is disabled. Anything the plugin did not clean up itself — menu items, composer buttons, event subscriptions — is removed by the host right after the disposer, so a missing disposer body cannot leak contributions.
- **Enable/disable.** The Settings → Plugins screen lists every discovered plugin with a toggle. Toggling applies immediately, without a page reload: disabling runs the disposer and clears the plugin's registry entries and subscriptions; enabling re-runs `setup` with a fresh `tg` object and restores its contributions.
- **Persistence.** The enabled/disabled choice is stored in localStorage, keyed by plugin name (globally, not per account), and read at startup: a disabled plugin is registered (listed in Settings) but its `setup` is never run until it is enabled.
- **Error isolation.** Errors in `setup`, in any handler (`onClick`, event handlers), and in `tg.api` / `tg.store` / `tg.util` calls are caught and logged to the console with the plugin name. A throwing plugin never crashes the client, other plugins keep working, and a half-registered plugin (setup that throws midway) leaves no partial contributions behind.

## `tg.ui`

UI contributions are declarative descriptors; the app's own components render them. Contributions render after the native items, in registration order, and disappear when the plugin is disabled.

```ts
// Message context menu (right-click a message). See hello-plugin.
tg.ui.addMessageContextMenuItem({
  icon: 'heart',              // icon name from src/types/icons/font.ts; optional
  label: 'React via plugin',
  // destructive: true,       // optional; renders the item red like Delete
  onClick: (message) => { /* ApiMessage the menu was opened on */ },
});

// Chat list context menu (right-click a chat). See ui-demo-plugin.
tg.ui.addChatContextMenuItem({
  label: 'Archive via plugin',
  onClick: (chat) => { /* ApiChat the menu was opened on */ },
});

// Main ("burger") menu, after the native entries. See ui-demo-plugin.
tg.ui.addMainMenuItem({
  label: 'My feature',
  onClick: () => {},
});

// Icon-only button in the chat composer bar. See ui-demo-plugin.
tg.ui.addComposerButton({
  icon: 'message',            // required; icon-only button
  label: 'My feature',        // accessible label
  onClick: ({ chatId, threadId }) => {},
});

// In-app notification. See hello-plugin / ui-demo-plugin.
tg.ui.showNotification({
  title: 'Optional bold first line',
  message: 'Notification body',
  icon: 'star',        // renderer defaults to an info icon
  duration: 3000,      // auto-dismiss in ms; renderer defaults to 3000
});
```

Repeated `showNotification` calls stack: every call carries a fresh generated id, so identical message bodies are not deduped by the notification pipeline.

## `tg.on`

Subscribe to app events. Returns an unsubscribe function for that one handler. Handlers the plugin does not unsubscribe itself are bulk-removed when the plugin is disabled, so a disposer only needs to cover cleanup the host cannot know about.

```ts
// Every event, with its payload shape:
const offNew = tg.on('message:new', ({ chatId, messageId, message }) => {});
const offEdited = tg.on('message:edited', ({ chatId, messageId, message }) => {
  // `message` may be partial: the source update can carry only the edited fields
});
const offDeleted = tg.on('message:deleted', ({ chatId, messageIds }) => {
  // `chatId` is undefined in some source updates — always check before use
});
const offOpened = tg.on('chat:opened', ({ chatId }) => {
  // `chatId === undefined` means the chat closed
});

offNew(); // stops this one handler; other handlers and plugins keep receiving
```

`chat:opened` fires on change only — there is no initial emission for the chat that is already open when the plugin loads, and unrelated store changes do not fire it.

Guarantees to design against:

- **Payloads carry the truth.** `message:*` handlers run in the same dispatch as the app's own update reducers and may run before them, so read the payload, never the store, inside a handler.
- **`chat:opened` can lag navigation.** It rides the app's store-change notification, which is throttled to tick end and deferred during heavy animations. Read `tg.store.getActiveChatId()` when you need the value *now*.

## `tg.api`

Fire-and-forget wrappers over the app's own store actions: a call inherits the app's optimistic-update pipeline, is scoped to the current tab, returns `void`, and never throws — a failing call is logged with the plugin name.

```ts
tg.api.sendMessage(chatId, 'Hello from my plugin!');
tg.api.sendMessage(chatId, 'In a topic', { threadId: 12 });   // defaults to the main thread
tg.api.editMessage(chatId, messageId, 'New text');            // only works in the OPEN chat (see below)
tg.api.deleteMessages(chatId, [messageId1, messageId2]);     // always addresses the main thread
tg.api.deleteMessages(chatId, [messageId], { shouldDeleteForAll: true });
tg.api.setReaction(chatId, messageId, '👍');
tg.api.openChat(chatId);
```

- `sendMessage` / `deleteMessages` skip (and log) chats that are not in the store.
- `editMessage` works only in the currently open chat — the underlying app action edits whatever the open thread's editing state points at, so the facade points that state at `messageId` first; editing another chat is logged and skipped.
- `setReaction` **toggles**: the same call sets the reaction when the current user has not reacted and removes it when they have.

## `tg.store`

Read-only plain data — never store handles, so plugin code cannot mutate app state. Every read returns `undefined` when unavailable.

```ts
const activeChatId = tg.store.getActiveChatId();    // undefined when no chat is open
const currentUserId = tg.store.getCurrentUserId(); // undefined when signed out
const chat = tg.store.getChat('12345');            // Readonly<ApiChat>, or undefined
```

## `tg.util`

```ts
tg.util.log('hello', { messageId: 42 });  // prefixed with the plugin name in the console
tg.util.getLocalizedString('Done');     // an app lang key → localized string
tg.util.getLocalizedString('SettingsPluginsAbout'); // keys resolve per the user's language
```

- `log(...args)` prefixes every line with the plugin name; non-string args are JSON-serialized.
- `getLocalizedString(key, variables?)` translates an app localization key. Valid keys are app keys — find them by their usage (`lang('SomeKey')` in components) or in `src/assets/localization/fallback.strings`; typing comes from `LangKey`. A failing translation logs and returns the raw key.

## Contract policy

The `tg` contract grows **additively only**: a release may add fields and methods, but never renames or removes them, so an existing plugin keeps compiling across releases.

When [`types.ts`](./types.ts) must change incompatibly anyway:

1. Add the new name alongside the old one — both work in the same release.
2. Mark the old name deprecated with a version note in its doc comment.
3. Update every bundled plugin in the same change — a deprecated name that still compiles in `hello-plugin`, `echo-plugin` or `ui-demo-plugin` is not deprecated.

Never break silently: a compile error in a plugin author's codebase is the last resort, and the release notes name the migration.

## Where to look when types change

- [`types.ts`](./types.ts) — the contract itself: every type, field and payload, with doc comments.
- Settings → Plugins — the live list of what is loaded, with its toggle state.
- The vitest suite under `src/plugins/` — pins the behavior: host lifecycle ([`host.test.ts`](./host.test.ts)), events ([`events.test.ts`](./events.test.ts)), the action facade ([`slices/api.test.ts`](./slices/api.test.ts)), store reads ([`slices/store.test.ts`](./slices/store.test.ts)), UI registries ([`slices/ui.test.ts`](./slices/ui.test.ts), [`registry.test.ts`](./registry.test.ts)) and utilities ([`slices/util.test.ts`](./slices/util.test.ts)).

If this README and [`types.ts`](./types.ts) disagree, `types.ts` wins and this README is the bug.
