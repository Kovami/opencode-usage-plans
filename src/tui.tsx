/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { quotaBar, quotaColor, windowLabel } from "./format"
import { blockOfProviderID, sortProviders } from "./order"
import { fetchAlibaba, resolveBl, type AlibabaOptions } from "./providers/alibaba"
import { detectKimi, fetchKimi } from "./providers/kimi"
import { detectOpenai, fetchOpenai } from "./providers/openai"
import { detectZai, fetchZai, type ZaiOptions } from "./providers/zai"
import type { ProviderState, QuotaWindow } from "./providers/types"

type Options = {
  kimi?: { enabled?: boolean }
  alibaba?: AlibabaOptions
  openai?: { enabled?: boolean }
  zai?: ZaiOptions
}

const REFRESH_MS = 300_000

const isVisible = (state: ProviderState) =>
  state.phase === "loading" || state.phase === "ok" || state.phase === "error"

const errorOf = (state: ProviderState) => (state.phase === "error" ? state : undefined)
const okOf = (state: ProviderState) => (state.phase === "ok" ? state : undefined)

export default Plugin.define({
  id: "usage-plans",
  setup(context) {
    const options = (context.options ?? {}) as Options
    const kimiEnabled = options.kimi?.enabled !== false
    const alibabaOptions = options.alibaba ?? {}
    const alibabaEnabled = alibabaOptions.enabled !== false
    const openaiEnabled = options.openai?.enabled !== false
    const zaiOptions = options.zai ?? {}
    const zaiEnabled = zaiOptions.enabled !== false

    const [kimi, setKimi] = createSignal<ProviderState>(
      kimiEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )
    const [alibaba, setAlibaba] = createSignal<ProviderState>(
      alibabaEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )
    const [openai, setOpenai] = createSignal<ProviderState>(
      openaiEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )
    const [zai, setZai] = createSignal<ProviderState>(
      zaiEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )

    // Last time a session actually used each provider, persisted across
    // restarts. Recently used providers sort to the top of the sidebar.
    const [lastUsed, setLastUsed] = context.storage.store("last-used", {
      initial: {} as Record<string, number>,
    })

    const markUsed = (providerID: string | undefined) => {
      const block = blockOfProviderID(providerID)
      if (!block) return
      void setLastUsed((draft) => {
        draft[block] = Date.now()
      })
    }
    const offModelSelected = context.data.on("session.model.selected", (event) =>
      markUsed(event.data.model.providerID),
    )
    const offExecutionStarted = context.data.on("session.execution.started", (event) =>
      markUsed(context.data.session.get(event.data.sessionID)?.model?.providerID),
    )

    let kimiBusy = false
    let alibabaBusy = false
    let openaiBusy = false
    let zaiBusy = false
    let kimiAbort: AbortController | undefined
    let alibabaAbort: AbortController | undefined
    let openaiAbort: AbortController | undefined
    let zaiAbort: AbortController | undefined

    const runKimi = async (initial = false) => {
      if (!kimiEnabled) return
      if (kimiBusy) return
      kimiBusy = true
      if (initial) setKimi({ phase: "detecting" })
      try {
        const credentials = await detectKimi()
        if (!credentials) {
          setKimi({ phase: "hidden" })
          return
        }
        kimiAbort?.abort()
        const abort = new AbortController()
        kimiAbort = abort
        setKimi({ phase: "loading" })
        const result = await fetchKimi(credentials, abort.signal)
        if (abort.signal.aborted) return
        if (Array.isArray(result)) {
          setKimi({ phase: "ok", windows: result })
        } else {
          setKimi({ phase: "error", message: result.error })
        }
      } catch {
        setKimi({ phase: "error", message: "Kimi usage unavailable" })
      } finally {
        kimiBusy = false
      }
    }

    const runAlibaba = async (initial = false) => {
      if (!alibabaEnabled) return
      if (alibabaBusy) return
      alibabaBusy = true
      if (initial) setAlibaba({ phase: "detecting" })
      try {
        const blPath = await resolveBl(alibabaOptions)
        if (!blPath) {
          setAlibaba({ phase: "hidden" })
          return
        }
        alibabaAbort?.abort()
        const abort = new AbortController()
        alibabaAbort = abort
        setAlibaba({ phase: "loading" })
        const result = await fetchAlibaba(blPath, alibabaOptions, abort.signal)
        if (abort.signal.aborted) return
        if (Array.isArray(result)) {
          setAlibaba({ phase: "ok", windows: result })
        } else {
          setAlibaba({ phase: "error", message: result.error })
        }
      } catch {
        setAlibaba({ phase: "error", message: "Alibaba usage unavailable — run bl login" })
      } finally {
        alibabaBusy = false
      }
    }

    const runOpenai = async (initial = false) => {
      if (!openaiEnabled) return
      if (openaiBusy) return
      openaiBusy = true
      if (initial) setOpenai({ phase: "detecting" })
      try {
        const credentials = await detectOpenai()
        if (!credentials) {
          setOpenai({ phase: "hidden" })
          return
        }
        openaiAbort?.abort()
        const abort = new AbortController()
        openaiAbort = abort
        setOpenai({ phase: "loading" })
        const result = await fetchOpenai(credentials, abort.signal)
        if (abort.signal.aborted) return
        if (Array.isArray(result)) {
          setOpenai({ phase: "ok", windows: result })
        } else {
          setOpenai({ phase: "error", message: result.error })
        }
      } catch {
        setOpenai({ phase: "error", message: "OpenAI usage unavailable" })
      } finally {
        openaiBusy = false
      }
    }

    const runZai = async (initial = false) => {
      if (!zaiEnabled) return
      if (zaiBusy) return
      zaiBusy = true
      if (initial) setZai({ phase: "detecting" })
      try {
        const credentials = await detectZai()
        if (!credentials) {
          setZai({ phase: "hidden" })
          return
        }
        zaiAbort?.abort()
        const abort = new AbortController()
        zaiAbort = abort
        setZai({ phase: "loading" })
        const result = await fetchZai(credentials, abort.signal, zaiOptions.baseUrl)
        if (abort.signal.aborted) return
        if (Array.isArray(result)) {
          setZai({ phase: "ok", windows: result })
        } else {
          setZai({ phase: "error", message: result.error })
        }
      } catch {
        setZai({ phase: "error", message: "Z.AI usage unavailable" })
      } finally {
        zaiBusy = false
      }
    }

    void runKimi(true)
    void runAlibaba(true)
    void runOpenai(true)
    void runZai(true)
    const kimiTimer = setInterval(() => void runKimi(), REFRESH_MS)
    const alibabaTimer = setInterval(() => void runAlibaba(), REFRESH_MS)
    const openaiTimer = setInterval(() => void runOpenai(), REFRESH_MS)
    const zaiTimer = setInterval(() => void runZai(), REFRESH_MS)

    const visible = () =>
      isVisible(kimi()) || isVisible(alibaba()) || isVisible(openai()) || isVisible(zai())

    const Windows = (props: { windows: QuotaWindow[] }) => (
      <For each={props.windows}>
        {(item) => (
          <box flexDirection="column">
            <text fg={quotaColor(item.usedPct)}>
              {item.label}  {quotaBar(item.usedPct)} {windowLabel(item.usedPct)}
            </text>
            <text fg={context.theme.text.muted}>
              {windowLabel(item.remainingPct)} left · resets {item.resetLabel}
            </text>
          </box>
        )}
      </For>
    )

    const Block = (props: { title: string; state: () => ProviderState }) => (
      <Show when={isVisible(props.state())}>
        <box flexDirection="column">
          <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <Show when={props.state().phase === "loading"}>
            <text fg={context.theme.text.muted}>loading…</text>
          </Show>
          <Show when={errorOf(props.state())}>
            {(state) => <text fg={context.theme.text.muted}>{state().message}</text>}
          </Show>
          <Show when={okOf(props.state())}>
            {(state) => (
              <>
                <Windows windows={state().windows} />
                <Show when={state().windows.length === 0}>
                  <text fg={context.theme.text.muted}>No usage data</text>
                </Show>
              </>
            )}
          </Show>
        </box>
      </Show>
    )

    const blocks = () =>
      sortProviders(
        [
          { id: "kimi" as const, title: "Kimi Code (kimi.ai)", state: kimi },
          { id: "alibaba" as const, title: "Alibaba Token Plan", state: alibaba },
          { id: "openai" as const, title: "OpenAI Codex", state: openai },
          { id: "zai" as const, title: "Z.AI Coding Plan", state: zai },
        ],
        lastUsed,
      )

    const disposeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={visible()}>
          <box flexDirection="column">
            <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
              Usage
            </text>
            <For each={blocks()}>
              {(block) => <Block title={block.title} state={block.state} />}
            </For>
          </box>
        </Show>
      ),
    })

    return () => {
      clearInterval(kimiTimer)
      clearInterval(alibabaTimer)
      clearInterval(openaiTimer)
      clearInterval(zaiTimer)
      kimiAbort?.abort()
      alibabaAbort?.abort()
      openaiAbort?.abort()
      zaiAbort?.abort()
      offModelSelected()
      offExecutionStarted()
      disposeSidebar?.()
    }
  },
})