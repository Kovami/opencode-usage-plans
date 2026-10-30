# Дизайн: глобальный менеджер моделей OpenCode V2 (субагент + серверный плагин)

**Дата:** 2026-10-30 · **Статус:** спецификация (ревизия 2, по итогам builder-check) · **Автор:** architect · **Режим:** design-only, без реализации

## 1. Цели

- Качество прежде экономии; подписка распределяется по квотам (alibaba ↔ kimi ↔ free); простые задачи — на бесплатные модели, когда менеджер-агент обосновал достаточность (эмпирическая пригодность моделей НЕ проверена — предложение, не факт).
- Менеджер-агент предлагает для каждой роли 3 тира (simple/normal/complex): primary + упорядоченные фолбэки (provider + model + variant).
- **Fail closed везде:** любой неутверждённый запрос управляемого пути (первый, последующие, дрейф) блокируется ДО передачи; отказ/отсутствие одобрения = БЛОК, никогда «дефолтная модель». Непринудимость — стоп-условие (G1).
- Автоматический технический фолбэк с продолжением на безопасной границе без дублирования побочных эффектов (G2).
- Траты: каждое диспетчеризованное плагином обращение к платному классу — отдельное одноразовое согласие, привязанное к запросу; неизвестная стоимость — fail closed; обычная трата квоты подписки в рамках одобренной схемы дополнительного согласия НЕ требует.
- Чувствительные задачи (auth/payments/secrets/удаление данных) — всегда complex-тир из strongSet + обязательный существующий security-гейт.
- Одобрения привязаны к root-сессии; глобальная серверная интеграция, не зависящая от TUI.

## 2. Не-цели (анти-цели)

- GUI/TUI-части менеджера; регрессия TUI-плагина `opencode-usage-plans` (изменения к нему — только аддитивные, §13).
- Метрика потраченных долларов в рантайме: у V2 plugin-API нет API расходов; классы биллинга + согласие + эвристическая оценка (не гарантия).
- Перенаправление/блок летящего запроса после передачи; авто-переназначение primary-модели, выбранной пользователем (§11).
- **Универсальная защита трат не заявляется:** покрытие = управляемые плагином пути (§14); ручная активность пользователя, другие плагины, MCP — вне покрытия.
- Изменение `~/.config/opencode/AGENTS.md` / `agents/*.md` до утверждения (пост-аппрув задача).
- Хранение новых секретов: только переиспользование существующих механизмов чтения креденшелов quota-провайдеров; ключи не логируются.

## 3. Ограничения

- Истина по API — только V2-доки и установленные типы `@opencode/plugin@2.2.1` (совпадает с зависимостью quota-плагина). Несуществующие хуки не предполагаются.
- Планировщик — оркестратор, менеджер — советник (LLM), **плагин — авторитарный enforcement**: решения применяет код плагина, никогда текст модели.
- Отдельный sibling-проект `/Users/alex/Projects/opencode-model-manager` (server-only плагин, экспорт `.`), глобальная загрузка через `plugins` в `~/.config/opencode/opencode.json`.
- Числа (пороги 80/95, TTL 5 мин, кап тех. переключений 2/10 мин, cooldown 10 мин) — **предложенные дефолты, не согласованные**.
- Пайплайн ролей и обязательный security-гейт сохраняются; product-owner/marketer — opt-in.

## 4. Альтернативы и выбор

| Вариант | Вердикт |
|---|---|
| Только промпт-инструкции | Отклонено: нет перехвата, одобрения из текста → prompt injection. |
| Только rule-router (`agent.transform`/`model.transform`) | Отклонено: эффект на всю локацию → нарушает изоляцию одобрений. Остаётся опциональным strict-режимом (off). |
| **Субагент + серверный плагин** | Выбрано пользователем: `session.switchModel` — по-сессионно; `permission.assert` + события — доверенный канал. |
| Применение схем через `agent.transform` | Отвергнуто: локация-глобально; только `session.switchModel`. |

## 5. Проверенная поверхность API (истина)

**Proven — доки** `https://opencode.ai/v2/docs/build/plugins/server` (Hooks→Sessions: «Prompt admission», «Model requests», «Model request», «Retry policy»; API: Models/Sessions/Permissions/Commands/Tools/Storage/Events), `/v2/docs/build/plugins` (Load/Publish), `/v2/docs/plugins` (Configure/Control/Manage/Reload):

- `Plugin.define({id, setup(ctx)})`; `ctx.options`; `ctx.location`; cleanup.
- `ctx.session.hook("prompt")` — admission **до** резолва модели («model resolution happens after admission»); «If preparation fails or is interrupted, OpenCode does not admit the prompt» (механизм блокировки admission — верифицировать в G1); ID сессии/сообщения readonly.
- `session.hook("context"|"compaction"|"generate"|"title")`, `"model.request"` (headers/baseURL), `"http.request"/"http.response"` (последняя точка перед передачей; body — one-shot stream, клонировать перед чтением), `"experimental.ws.handshake"` (раз на model call до выбора сокета), `"retry"` (decision retry true/false; «built-in maximum attempt count remains a hard limit»); `event.model` везде readonly; `event.kind`: primary/compaction/title/generate.
- `ctx.session.switchModel` — «subsequent requests»; повтор pending/delivered ID admission «returns the original admission without rerunning hooks».
- `ctx.permission.assert({sessionID, agent?, action, resources, save?, metadata?})`; reply `once|always|reject`; `ctx.permission.hook("evaluate")` — на allow/ask, может поставить `deny`+message (конфиг-deny финален).
- `ctx.tool.transform` — «a later valid registration overrides the same effective tool name» (основа dispatch-wrapper); `ctx.command.transform`; `ctx.event.subscribe({types})`: `session.created` (data: sessionID, projectID, location, subpath, **parentID**), `session.deleted/forked/error/idle/permissions`, `permission.asked/replied` (data: sessionID, **requestID**, reply), `model.updated`, `config.updated`.
- `ctx.storage.get/set/remove/scan({prefix})`; `ctx.model.list()/transform` (прецедент фильтра моделей по cost — «model-budget»).

**Proven — типы** (`node_modules/@opencode/plugin/dist/promise/{session,plugin,registration,permission,tool,command,event,storage}.d.ts`, `dist/permission.d.ts`; `@opencode/schema/dist/{session,agent,model,permission,session-event}.d.ts`): `SessionHooks`; `SessionDomain` (switchModel/synthetic/list с фильтром `parentID`); `Agent.Info` (`model`, `mode`, `permissions`, `Model.Ref.parse`); `Model.Info` (`variants`, `cost[]`, `enabled`, `limit`, `capabilities`); `Permission.Reply`; `session.created.data.parentID`.

**Каталог:** 27 моделей / **7 провайдеров, включая strata** (данные родительской сессии). Локальная проверка субагента (`tools.opencode.models`) видела 6 из 7 (alibaba-token-plan, kimi-code-plan-global, opencode, google, openai, strata); один провайдер не виден субагентской сессии. Каталог менеджера строится из `ctx.model.list()` сервера, не из этого отчёта. `cost=0` и `cost=[]` НЕ трактуются как «бесплатно»; openai по имени НЕ исключается (класс по ROUTE, §13).

**Unverified (закрывается гейтами §17):** admission-хук для стартового промпта сабагента; блок admission при throw в хуке; блок pre-transmission в `http.request`/`ws.handshake`; force-ask при уникальном ресурсе; видимость промпта из дочерней сессии; атомарное одноразовое потребление; изоляция storage; форма `session.error`; безопасное авто-продолжение.

## 6. Архитектура

```
Plugin "opencode-model-manager" (глобальная загрузка, server-only)
 policy    — классы биллинга по ROUTE, роли/тиры/sensitive, валидация схем, опции (proposal, не approval)
 catalog   — снапшот ctx.model.list() + классификация + cooldown + валидность кандидатов
 quota     — санитизированный слой над providers из opencode-usage-plans + кэш/TTL/dedupe + ROUTE-метки
 consents  — доверенный канал: свежий ask с уникальным ресурсом + наблюдение permission.replied;
             реестр одноразовых DispatchConsent (spend); scheme/manager-model одобрения по root-сессии
 validate  — перепроверка кандидатов (модель/вариант/маршрут) против живого каталога + fingerprint схемы
 enforce   — G1: L0 deny диспетча / L1 admission+switchModel / L2 блок pre-transmission (HTTP+WS), дрейф=блок
 fallback  — G2: retry-hook → cooldown → switchModel → безопасное авто-продолжение; кап → блок+отчёт
 tools     — models_propose / models_request_approval / models_hint / models_escalate / models_status
 agent     — субагент model-manager; диспетч разрешён только при root-подтверждении его модели (§11)
 report    — session.synthetic в root + журнал; команда /model-manager
```

## 7. Интерфейсы

```ts
// policy.ts
type BillingClass = "subscription" | "free" | "paid-known" | "paid-unknown"
type CredentialRoute = "chatgpt-plan" | "api-key" | "cli-subscription" | "unknown" // метка, без секретов
type RouteFingerprint = string // хэш(provider + route + несекретной идентичности маршрута)
type ModelRef = { providerID: string; modelID: string; variant?: string }          // = Model.Ref
type Tier = "simple" | "normal" | "complex"; type RoleID = string
interface SchemeEntry { role: RoleID; tier: Tier; ladder: ModelRef[] }             // primary + fallbacks
validateScheme(scheme, catalog, policy): ValidationReport
// существование+enabled, variant ∈ Model.Info.variants (пусто ⇒ без variant), класс по ROUTE,
// sensitive ⇒ tier=complex ∧ ⊂ strongSet, платные — вне схемы (только через DispatchConsent)

// consents.ts — ЕДИНСТВЕННАЯ точка записи одобрений
interface SchemeApproval { rootSessionID: string; schemeRev: number; scheme: SchemeEntry[];
  routes: Record<string, RouteFingerprint>; hash: string; requestID: string; grantedAt: number }
interface ManagerModelApproval { rootSessionID: string; model: ModelRef;
  route: RouteFingerprint; requestID: string; grantedAt: number }
interface DispatchConsent { dispatchID: string; attempt: number;
  fingerprint: string // hash(model + route + billing + payload)
  rootSessionID: string; requestID: string; grantedAt: number; consumedAt?: number }
freshAsk(root, action, resources, metadata): Promise<Consent|Refused>
// assert с УНИКАЛЬНЫМ ресурсом (без save) + согласие = наблюдённый permission.replied для этого
// requestID (keystroke). Авто-разрешение правилом allow/«always» согласием НЕ считается (G3).
consumeDispatchConsent(dispatchID, attempt, fingerprint): Consumed|Blocked // атомарно, однократно

// enforce.ts / fallback.ts
onPermissionEvaluate(event): void        // L0: deny "subagent" управляемой роли без валидной схемы/подтверждения
onPromptAdmission(event): Promise<void>  // L1: switchModel до резолва; нет валидного кандидата ⇒ блок admission
wrapSubagentDispatch(...)               // L1-резерв: обёртка/оверрайд tool диспетчера (override по докам)
onModelRequest(event): void              // дрейф-детект (model readonly) → пометка на блок в L2
onHttpRequest/onWsHandshake(event): void // L2: pre-transmission — проверка схемы/согласия; нарушение ⇒ БЛОК
onRetry(event): void                     // терминальная ошибка → cooldown + switchModel + G2-продолжение
```

Инструменты (namespace `models`, точки → `_`): `models_propose` (без побочных эффектов), `models_request_approval` (обёртка `freshAsk`), `models_hint` (planner: роль/тир/sensitive перед диспетчем), `models_escalate`, `models_status`.

## 8. Хранение (`ctx.storage`)

| Ключ | Содержимое |
|---|---|
| `policy/options` | опции из `opencode.json` (proposal-предпочтения, НЕ одобрения) |
| `quota/<provider>` | `{windows(+resetAt), fetchedAt, route, phase}` |
| `approvals/<rootSessionID>/scheme` | `SchemeApproval` |
| `approvals/<rootSessionID>/manager-model` | `ManagerModelApproval` (root-scoped, §11) |
| `consents/<rootSessionID>/dispatch/<dispatchID>` | `DispatchConsent` (одноразовые) |
| `log/<rootSessionID>` | переключения/блокировки/эскалации |

До верификации изоляции storage (G3) заявления о приватности сессий не делаются. Ключи через глобально уникальный `rootSessionID`.

## 9. Идентичность сессии и границы одобрений

- Root — сессия без `parentID` (обход `session.get`). Одобрение действует для root и потомков; дети собственных одобрений не имеют.
- Fork: `session.forked` → новый ID, наследования нет; управляемые диспетчи под форк-root **блокируются** до нового одобрения.
- Resume той же сессии сохраняет одобрение — **выбор дизайнера** (трактовка «текущая сессия»).
- `session.deleted` → рекурсивное удаление детей → GC записей и одноразовых согласий.

## 10. Доверенный канал одобрений vs prompt injection

- Согласие = пара {уникальный `permission.asked`, наблюдённый `permission.replied` для этого requestID} — свежий keystroke пользователя на запрос с уникальным ресурсом. `save` не передаётся; сессионные правила `session.update` менеджером НЕ пишутся; **существующие allow-правила и «always» согласием не считаются** — при авто-разрешении без `asked` согласие не создаётся, запрос блокируется.
- Записи создаются только внутри `consents.*` из наблюдённых событий; текст LLM, промпты, файлы, вывод tools — никогда не источник.
- Предложение менеджера — недоверенный вход: инструмент валидирует refs по `ctx.model.list()` до показа; в промпте точные ресурсы `role/tier/provider/model#variant`; hash связывает запись со схемой.
- Инъекция в худшем случае: плохое предложение (пользователь видит и отклоняет → БЛОК), занижение сложности хинта (ограничено sensitive⇒complex+security-гейт), отказ (БЛОК). Никакого «fail-safe на дефолты».

## 11. Маршрутизация, bootstrap, enforcement (G1)

- **Primary-модель пользователя вне авто-переназначения.** Управляемые пути: (a) диспетчи управляемых ролей (сабагенты), (b) все запросы менеджер-агента, (c) запросы, инициированные плагином (в т.ч. на root: generate/compaction/title через плагин). Ручные действия пользователя (ввод, ручная смена модели), другие плагины, MCP — неуправляемые; защита трат на них не заявляется.
- **Bootstrap менеджера:** модель предлагается в глобальном конфиге (proposal, НЕ одобрение). Подтверждение — только root-сессионное: `/model-manager` (executive команды — серверный код, без LLM) вызывает `freshAsk("model-manager.bootstrap")`; диспетч сабагента `model-manager` без `ManagerModelApproval` этого root блокируется (L0). Платная модель менеджера дополнительно требует DispatchConsent на каждое его обращение (практически: модель менеджера — класс subscription/free). Менеджер никогда не запускается на неподтверждённой модели, чтобы получить одобрение.
- **Без лишних вызовов LLM:** авто-применение одобренной схемы — код плагина; LLM — только генерация предложения и анализ провалов.
- **Enforcement (все управляемые запросы, первый и каждый последующий):**
  - L0: `permission.hook("evaluate")` → `deny` диспетча управляемой роли/менеджера при отсутствии валидной схемы или валидного кандидата (БЛОК до создания ребёнка).
  - L1: admission-хук `prompt` (если выполняется для admission сабагента — G1) — `switchModel` до резолва модели; валидного кандидата нет ⇒ сбой admission (БЛОК). Резерв: dispatch-wrapper (override инструмента диспетчеризации).
  - L2: pre-transmission контроль в `http.request` и `experimental.ws.handshake`: модель сессии ∉ валидной схеме (включая **дрейф**) или платный запрос без живого DispatchConsent ⇒ **БЛОК до передачи** (механизм чистого блока — throw/подмена запроса — верифицируется в G1; «пропустить один дрейф-запрос и поправить потом» не допускается).
  - Непокрытый автоматический путь (транспорт без хуков и т.п.) — блокирующий гейт, а не принятое ограничение.

## 12. Автоматический фолбэк (G2)

- Терминальная провайдерная ошибка: `retry`-хук → cooldown модели → `switchModel` на следующий **валидный** элемент одобренной лестницы (перепроверка каталога/маршрута, §14) → автоматическое продолжение задачи на безопасной границе.
- Безопасная граница = в провалившейся попытке нет завершённых побочных эффектов (проверка `session.context` дочерней сессии). Тогда плагин пере-отправляет задачу (повтор admission не дублирует хуки). При частичных эффектах авто-повтор запрещён (дубль эффектов) → отчёт + planner-опосредованный re-dispatch «продолжить с текущего состояния».
- Подписочные ретраи в рамках схемы автоматичны; **любая платная попытка/ретрай — новое согласие** (§14). Кап тех. переключений (предложено 2/10 мин) → дальнейшие управляемые диспетчи роли блокируются с отчётом. Эскалация выше лестницы — только новое одобрение.

## 13. Квоты и ROUTE

- Слой квот — санитизированный переиспольз `src/providers/{kimi,openai,alibaba}.ts` (vitest-покрыты) через **аддитивный экспорт `./providers`** в `opencode-usage-plans` (package.json + barrel; `QuotaWindow` += `resetAt` epoch ms). Минимальные обоснованные изменения TUI-пакета; новых хранилищ креденшелов нет; секреты не покидают адаптеры и не логируются.
- ROUTE-метки без секретов: kimi → auth.json `kimi-code-plan-global` (подписка); alibaba → `bl` CLI (подписка); openai → `detectOpenai` различает codex/ChatGPT-маршрут (subscription) и API-key (paid). strata: маршрут неизвестен → fail closed. gemma (0/0): класс по маршруту, не по цене каталога; «free» = только верифицированный маршрут.
- Shared-пулы: alibaba — общий агрегат провайдера; kimi — 5h+месяц; openai — primary/secondary. Пороги (предложено 80/95) — влияние на выбор тиров.
- Stale: TTL (предложено 5 мин, как `REFRESH_MS` в `src/tui.tsx`); ошибка fetch → «unknown»: не «полно»/не «пусто», routing по тиру + статус в предложение.
- Конкурентность: один in-flight fetch на провайдера (busy-флаг по паттерну tui.tsx), AbortController; дубль между локациями допустим (дедупликация по `fetchedAt` best-effort).

## 14. Политика оплаты и валидность кандидатов

- Классы: `subscription` (по ROUTE), `free` (верифицированный маршрут), `paid-known` (google, API-key маршруты), `paid-unknown` (`cost: []` без доказуемого маршрута). `cost=0/[]` — не основание для «бесплатно».
- **Подписка:** обычная трата квоты в рамках одобренной схемы дополнительного человеческого согласия НЕ требует. **Платное:** каждое управляемое плагином обращение (включая transport-ретраи, tool-loop ходы, compaction/title/generate, запросы менеджера, plugin-triggered root-вызовы) — отдельный DispatchConsent: `{dispatchID, attempt, hash(model+route+billing+payload)}`, потребляемый **атомарно и однократно немедленно перед отправкой** (L2); любая повторная попытка — новое согласие. Оценка стоимости в metadata — эвристика, не гарантия. Грантов «навсегда»/глобальных нет.
- **Валидность (перепроверка при каждом выборе и на L2):** исчезновение модели/варианта из каталога, смена ROUTE-отпечатка провайдера → кандидат недействителен, его отложенные DispatchConsent аннулируются; выбор — только другой одобренный валидный кандидат лестницы; лестница исчерпана или маршрут изменился ⇒ БЛОК + запрос возобновлённого одобрения схемы (смена маршрута всегда требует нового scheme-approval). SchemeApproval связывает model refs (provider/model/variant), revision схемы и ROUTE-отпечатки.
- Strict-режим (опция, off): дополнительно убирать платные/unknown модели из кандидатов через `ctx.model.transform`.

## 15. Эскалация качества

- Сигнал — независимая проверка: провал review (правило «2 провала → эскалация») → `models_escalate` → подъём тира роли на ступень **внутри** одобренной лестницы (simple→normal→complex→фолбэки, только валидные кандидаты), применение к новым детям, отчёт. Исчерпана лестница → новое одобрение, никогда молча выше.
- Менеджер-агент анализирует провал (советник); применяет — плагин. Частичные правки: менеджер файлов не редактирует; повторная диспетчеризация — «продолжить с текущего состояния» (промпт planner).

## 16. Тесты и критерии приёмки

- Unit (vitest, чистые функции): `validateScheme`; резолюция тиров/границы эскалации; валидность кандидатов и аннулирование согласий; запись согласий только из наблюдённых replied-событий; атомарное потребление DispatchConsent (однократность, attempt); ROUTE-классификация; staleness/cooldown; `resetAt`-парсеры.
- Приёмка (ручной чек-лист):
  1. Первый и каждый последующий управляемый запрос идёт только по валидному кандидату схемы; дрейф модели ⇒ следующий запрос **заблокирован до передачи** (не «улетел и поправили»).
  2. Отказ/отсутствие одобрения ⇒ диспетч заблокирован; запросов на «дефолтных» моделях нет.
  3. Фолбэк: side-effect-free провал → авто-продолжение на валидном фолбэке без дублей; провал с частичными эффектами → блок авто-повтора + отчёт.
  4. Платное: без живого DispatchConsent запрос (включая compaction/title/ретрай) блокируется; согласие одноразово — вторая попытка без нового согласия блокируется; при существующем allow-правиле авто-разрешение согласием не считается (force-ask).
  5. Инвалидация: модель/вариант исчезли или ROUTE изменился → кандидат выпадает, отложенные согласия сняты, взят следующий валидный; исчерпана ⇒ блок + запрос нового одобрения.
  6. Bootstrap: глобальный конфиг сам по себе менеджера не включает; без root-подтверждения модели менеджера диспетч заблокирован; primary-модель пользователя не переназначается.
  7. Fork — блок до одобрения; resume той же ID — одобрение живо (designer choice); `session.deleted` — GC.
  8. Секреты отсутствуют в логах/отчётах/промптах; TUI-плагин без регрессий; `npm run check` обоих проектов зелёный.

## 17. Feasibility gates (до финализации плана реализации)

- **G1 (блокирующий):** доказать БЛОК до передачи для первого и каждого последующего управляемого запроса на всех путях (HTTP и WS): admission-хук сабагента / dispatch-wrapper / L2-блок (`http.request`, `ws.handshake`) при throw или подмене запроса; deny диспетчера через `evaluate`. `session.created`-watcher — только детектор, НЕ enforcement. **Если хотя бы один путь непринудим — СТОП внедрения: отчёт о невозможности и требуемых изменениях ядра (admission-хук для сабагентов, deny-семантика в model/http-хуках). Ослабление «пропустить один запрос» не допускается.**
- **G2 (блокирующий):** реализуемость детекта «провал без побочных эффектов» (форма `session.error` + сообщения дочерней сессии) и пере-отправки без дублирования admission/эффектов. Невозможно → вопрос пользователю о пересмотре скоупа авто-восстановления (только после измеренного провала).
- **G3 (блокирующий):** доверенный канал согласий: force-ask при уникальном ресурсе (assert промптит несмотря на allow-правила; авто-разрешение не согласие); наблюдаемость `permission.replied` с requestID; видимость промпта, поднятого из дочерней сессии; атомарное однократное потребление; изоляция storage для записей сессий (иначе заявления о приватности не делаются). Если assert не может force-ask — использовать другой поддерживаемый доверенный канал или СТОП.
- **G4 (не блокирующий):** скоуп storage между локациями (только дедупликация квот), семантика `always` без `save`.

## 18. Нерешённые вопросы пользователю

Сейчас — **нет**: биллинг-«вопрос» снят (fail closed уже требуется), компромисс G1 запрещён. Условные вопросы возникают только после измеренного провала гейтов:
1. (после провала G2) авто-восстановление при частичных эффектах: planner-опосредованный re-dispatch или пересмотр скоупа.
2. (после провала G1/G3) — вопроса нет: стоп + отчёт о требуемых изменениях ядра OpenCode.

## 19. Минимальный скелет работ (после утверждения; детальный план — отдельно)

1. **Прототипы G1/G2/G3 — ДО любых изменений пакета quota** (backender; при провале — отчёт architect'у, стоп).
2. Аддитивный экспорт `./providers` + `resetAt` в `opencode-usage-plans` (backender, 2-3 файла).
3. `policy/catalog/quota` (ROUTE-метки) → `consents` → `enforce/fallback` → `tools/agent/command` (backender, по 1-3 файла).
4. Security-гейт после `consents/enforce` (секреты, доверие, инъекции); reviewer после каждой задачи.
5. Пост-аппрув конфиг: `~/.config/opencode/AGENTS.md` + `agents/planner.md` (снять запрет model-override, добавить диспетчеризацию `model-manager`).
