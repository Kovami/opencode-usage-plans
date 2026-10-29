/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { quotaBar, quotaColor, windowLabel } from "./format"
import { fetchAlibaba, resolveBl, type AlibabaOptions } from "./providers/alibaba"
import { detectKimi, fetchKimi } from "./providers/kimi"
import type { ProviderState, QuotaWindow } from "./providers/types"

type Options = {
  kimi?: { enabled?: boolean }
  alibaba?: AlibabaOptions
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

    const [kimi, setKimi] = createSignal<ProviderState>(
      kimiEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )
    const [alibaba, setAlibaba] = createSignal<ProviderState>(
      alibabaEnabled ? { phase: "detecting" } : { phase: "hidden" },
    )

    let kimiBusy = false
    let alibabaBusy = false
    let kimiAbort: AbortController | undefined
    let alibabaAbort: AbortController | undefined

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

    void runKimi(true)
    void runAlibaba(true)
    const kimiTimer = setInterval(() => void runKimi(), REFRESH_MS)
    const alibabaTimer = setInterval(() => void runAlibaba(), REFRESH_MS)

    const visible = () => isVisible(kimi()) || isVisible(alibaba())

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
            {(state) => <Windows windows={state().windows} />}
          </Show>
        </box>
      </Show>
    )

    const disposeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={visible()}>
          <box flexDirection="column">
            <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
              Usage
            </text>
            <Block title="Kimi Code (kimi.ai)" state={kimi} />
            <Block title="Alibaba Token Plan" state={alibaba} />
          </box>
        </Show>
      ),
    })

    return () => {
      clearInterval(kimiTimer)
      clearInterval(alibabaTimer)
      kimiAbort?.abort()
      alibabaAbort?.abort()
      disposeSidebar?.()
    }
  },
})