# Coucou — intégration OpenCode

Règle d'or : **vérifier la doc officielle au moment d'implémenter**. Les formats
ci-dessous sont le plan, pas une garantie. Sources à relire :
- Plugins OpenCode (V1) : https://opencode.ai/docs/plugins
- Plugins OpenCode (V2) et migration V1 → V2 : https://opencode.ai/v2/docs/build/plugins/migrate-v1

---

## 1. Ce que ça fait

OpenCode 1 et OpenCode 2 sont supportés par **un seul fichier** :
`NotchBuddy/Resources/opencode/coucou.ts`. Ce fichier est partagé tel quel par les
deux apps :

- macOS : il est copié depuis le bundle vers `~/.config/opencode/plugins/coucou.ts`
  (bouton **Install plugin** dans les réglages).
- Windows : la crate `coucou` l'embarque avec `include_str!` et le copie vers
  `%USERPROFILE%\.config\opencode\plugins\coucou.ts` (bouton **Install plugin**).

OpenCode charge automatiquement tous les `*.ts` de ce dossier : **aucun
`opencode.json` n'est lu ni réécrit**, exactement comme les hooks Claude Code.

Une fois installé, une session OpenCode apparaît dans l'île (mêmes étapes, mêmes
libellés) et les demandes de permission s'approuvent depuis l'encoche.

## 2. Architecture

```
opencode (TUI / run)
  └─ plugin coucou.ts ─► relais (nb-hook sur macOS, coucou-hook.exe sur Windows)
                            └─ socket Unix / pipe nommé ─► Coucou.app
                            ◄─ décision (pour PermissionRequest)
```

Le plugin ne parle pas directement au socket : il réutilise le **relais déjà
livré** par Coucou. Le relais connaît le chemin du socket/pipe, le SID Windows,
la troncature des gros champs et la traduction de la décision en JSON de hook.
Le plugin se contente de fabriquer des charges utiles au format Claude Code, que
l'app sait déjà lire, avec un champ `source: "opencode"` pour ne pas être filtré
comme une session VS Code.

Règle dure, identique côté Claude Code : **ne jamais bloquer OpenCode**.

- Tous les appels sont enveloppés : relais absent, app fermée, pipe cassé → coût
  nul pour l'agent.
- Une permission que Coucou ne tranche pas (app fermée, délai dépassé) est rendue
  à OpenCode comme `ask` : le prompt natif s'affiche comme si le plugin n'était
  pas là.

## 3. Correspondance des événements

| OpenCode (V1 `event` / V2 `ctx.event`) | Charge Coucou |
|---|---|
| `session.created` | `SessionStart` |
| `session.idle` | `Stop` (`finished`) |
| `session.error` | `StopFailure` (`error`) |
| `session.deleted` | `SessionEnd` |
| `session.status` (`retry` sur limite d'usage) | `Notification` (`ratelimit`) |
| hook `chat.message` / `ctx.session.hook("prompt")` | `UserPromptSubmit` |
| hook `tool.execute.before` | `PreToolUse` |
| hook `tool.execute.after` | `PostToolUse` / `PostToolUseFailure` |
| hook `permission.ask` / `ctx.permission.hook("evaluate")` | `PermissionRequest` (bloquant) |

Les identifiants d'outils OpenCode sont en minuscules (`bash`, `edit`, …) ; le
plugin les renomme (`Bash`, `Edit`, …) et traduit `filePath` en `file_path` pour
que les libellés français de l'app s'appliquent sans changement.

## 4. Permissions

OpenCode est permissif par défaut : un outil à `allow` ne passe pas par le hook de
permission. Pour que Coucou puisse approuver, deux chemins :

- **V1** : le hook `config` passe `bash`, `edit` et `webfetch` à `ask` **si
  l'utilisateur ne les a pas déjà réglés**. Coucou tranche alors à la place du
  prompt natif.
- **V2** : le hook `evaluate` est appelé aussi pour les décisions `allow` ; le
  plugin intercepte les mêmes outils.

L'ensemble est réglable via les options du plugin (`gate`) ; `{ "gate": false }`
désactive toute interception. Un `deny` explicite dans `opencode.json` reste
toujours final.

## 5. Installation manuelle

Sans l'app, copier le plugin et relancer OpenCode :

```bash
mkdir -p ~/.config/opencode/plugins
cp NotchBuddy/Resources/opencode/coucou.ts ~/.config/opencode/plugins/coucou.ts
```

Pour pointer vers un relais construit ailleurs, définir `COUCOU_HOOK` (chemin de
`nb-hook` ou `coucou-hook.exe`).

## 6. Tests

La traduction événements/permissions → charges utiles est pure et testée sans
OpenCode ni Coucou :

```bash
node --test tests/opencode/
```

Le reste (relais, abonnement, hooks) ne peut se vérifier qu'avec un OpenCode réel
et Coucou lancé.
