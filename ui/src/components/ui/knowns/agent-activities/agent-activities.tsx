"use client";
/** @registry name="agent-activities" type="ui" title="Agent activities" description="Glanceable capsules for a running agent, built on live-activity: run progress through Plan, Tools and Answer with Approve and Chat, an ETA with a mini agent graph, a budget as thin ticks, a budget-left ring, a voice agent's waveform with tokens per second, and a handoff countdown." */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { SwapText } from "@/ui/lib/knowns/motion";
import { AnimatedNumber } from "../animated-number";
import { Avatar } from "../avatar";
import { toolMark } from "@/ui/lib/knowns/icons/tool-icons";
import { Button } from "../button";
import { ActivityTicks, LiveActivity, spokenClock, stageIndex, stageState, type ActivityStage, type LiveActivityProps } from "../live-activity/live-activity";
import { ACCENT, TONE_COLOR, budgetTone, etaWords, layoutGraph, ringOffset, shortClock, waveBars, type GraphNode } from "./activity-math";

export { layoutGraph, ringOffset, budgetTone, waveBars, etaWords, shortClock, type GraphNode, type GraphNodeState } from "./activity-math";

type Base = Omit<LiveActivityProps, "trailing" | "state" | "leading" | "title" | "children" | "actions" | "bigValue" | "valueLabel" | "compact"> & {
  /** The agent: its name labels the avatar. */
  agent: string;
  /** Replaces the avatar in the leading slot. */
  leading?: ReactNode;
  /** A mark for the avatar instead of the initial: a brand or tool name ("Slack", "GitHub") or your own icon. Initials stay the fallback. */
  logo?: ReactNode;
  /** The row's title. Default the agent's name. */
  title?: ReactNode;
};
/** A brand or tool name becomes its logo; anything else is used as given. Null when nothing fits, so the initial shows. */
const markOf = (logo?: ReactNode) => (typeof logo === "string" ? toolMark(logo) : (logo ?? null));
const lead = (agent: string, leading?: ReactNode, hue?: string, logo?: ReactNode) => leading ?? <Avatar label={agent} icon={markOf(logo)} initials={agent.charAt(0).toUpperCase()} hue={hue} size={logo ? "md" : "sm"} shape="circle" />;

const markSvg = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
/** A handset, for a voice agent. Follows the text colour. */
export const PhoneGlyph = () => (
  <svg {...markSvg} aria-hidden="true">
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z" />
  </svg>
);
/** A check inside a shield, for a reviewing agent. Follows the text colour. */
export const CheckGlyph = () => (
  <svg {...markSvg} aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </svg>
);
const fmtNum = (n: number) => new Intl.NumberFormat().format(Math.round(n));
const move = "transition-transform duration-(--kn-dur-slow) ease-(--kn-ease-inout) motion-reduce:transition-none";

const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </svg>
);

/* ── 1. Run progress: one pill track with a sliding knob ── */

const glyph = (d: string) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const RUN_STAGES: readonly ActivityStage[] = [
  { id: "plan", label: "Plan", icon: glyph("M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01") },
  { id: "tools", label: "Tools", icon: glyph("M10.5 2.5a3.2 3.2 0 0 0-3 4.3L2.7 11.6a1.4 1.4 0 0 0 2 2l4.8-4.8a3.2 3.2 0 0 0 4.3-3l-2 2-1.7-.3-.3-1.7z") },
  { id: "answer", label: "Answer", icon: glyph("M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z") },
];

/**
 * One rounded track with a stage icon per stop, a filled segment that grows to the current stop and a knob that slides to it.
 * Both move on transform only, 280ms, ease in and out. When every stage is done the knob leaves and the icons turn to ticks.
 */
export function StageTrack({ stages, current, finished = false, className }: { stages: readonly ActivityStage[]; current: number | string; finished?: boolean; className?: string }) {
  const i = stageIndex(stages, current);
  const n = Math.max(1, stages.length);
  const pct = finished ? 1 : (Math.max(0, i) + 0.5) / n;
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  return (
    <div role="list" aria-label="Stages" className={cn("flex flex-col gap-1.5", className)}>
      <div className="relative h-10 overflow-hidden rounded-full bg-foreground/10">
        <div aria-hidden="true" className={cn("absolute inset-0 rounded-full", move)} style={{ transform: `translateX(${-(1 - pct) * 100}%)`, background: "var(--kn-accent, var(--primary))" }} />
        <div aria-hidden="true" className="absolute inset-y-0 left-0 grid place-items-center [transition:transform_var(--kn-dur-slow)_var(--kn-ease-inout),opacity_var(--kn-dur-fast)_var(--kn-ease-out)] motion-reduce:[transition:none]" style={{ width: `${100 / n}%`, transform: `translateX(${Math.max(0, i) * 100}%)`, opacity: finished ? 0 : 1 }}>
          <span className="size-8 rounded-full bg-white shadow-sm" />
        </div>
        <div className="relative grid h-full items-center" style={cols}>
          {stages.map((s, k) => {
            const st = stageState(k, i, finished);
            return (
              <span key={s.id} role="listitem" aria-current={st === "current" ? "step" : undefined} className={cn("grid place-items-center transition-colors duration-(--kn-dur-slow) ease-(--kn-ease-inout) [&_svg]:size-4", st === "done" ? "text-white" : st === "current" ? "text-[color:var(--kn-accent,var(--primary))]" : "text-muted-foreground")}>
                {st === "done" ? <Check /> : s.icon ?? <span className="size-1.5 rounded-full bg-current" />}
                <span className="sr-only">{`${s.label}${st === "done" ? ", done" : st === "current" ? ", in progress" : ", not started"}`}</span>
              </span>
            );
          })}
        </div>
      </div>
      <div className="grid text-center text-[12px] text-muted-foreground" style={cols} aria-hidden="true">
        {stages.map((s, k) => (
          <span key={s.id} className={cn("transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", stageState(k, i, finished) === "current" && "font-medium text-foreground")}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface RunProgressActivityProps extends Base {
  /** Where the run is. */
  stage: "plan" | "tools" | "answer" | (string & {});
  /** The run is done. */
  finished?: boolean;
  /** Once finished, write "Done" small and muted instead of big, so a list of finished runs stays quiet. */
  quietWhenDone?: boolean;
  /** What it is doing right now: "Searching the help centre". Swaps in place. */
  step?: ReactNode;
  /** The result line once finished, in the past tense: "Replied · 2m". Default "Finished". */
  result?: ReactNode;
  /** It is waiting for a person: shows Approve and the question, and the dot reads "Needs you". */
  approval?: { question: ReactNode };
  /** Approve was just pressed: shows a quiet "Approved" in place of the button, for a beat. Clear it when you like. */
  approved?: boolean;
  onApprove?: () => void;
  onChat?: () => void;
  /** Stages to show instead of Plan, Tools and Answer. */
  stages?: readonly ActivityStage[];
}

/** A run moving through its stages on one track, with the step it is on and round Approve and Chat buttons when a person is needed. */
export function RunProgressActivity({ agent, leading, logo, title, stage, finished, quietWhenDone, step, result, approval, approved, onApprove, onChat, stages = RUN_STAGES, accent = ACCENT.run, defaultExpanded = true, ...rest }: RunProgressActivityProps) {
  const i = stageIndex(stages, stage);
  const word = finished ? "Done" : stages[Math.max(0, i)]?.label ?? "";
  const asking = !!approval && !finished;
  return (
    <LiveActivity
      {...rest}
      accent={accent}
      defaultExpanded={defaultExpanded}
      leading={lead(agent, leading, accent, logo)}
      title={title ?? agent}
      subtitle={rest.subtitle ?? (finished ? <SwapText value="result">{result ?? "Finished"}</SwapText> : step ? <SwapText value={String(step)}>{step}</SwapText> : undefined)}
      state={asking ? "blocked" : finished ? "finished" : "busy"}
      bigValue={!(finished && quietWhenDone)}
      trailing={<SwapText value={word}>{word}</SwapText>}
      valueLabel={finished ? undefined : `${Math.max(0, i) + 1} of ${stages.length}`}
      actions={
        asking || approved || onChat ? (
          <>
            {approved && !asking && (
              <Button size="sm" variant="quiet" className="rounded-full" disabled>
                <Check /> Approved
              </Button>
            )}
            {asking && (
              <Button size="sm" variant="primary" className="rounded-full" onClick={onApprove}>
                Approve
              </Button>
            )}
            {onChat && (
              <Button size="sm" variant="secondary" className="rounded-full" onClick={onChat}>
                Chat
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <StageTrack stages={stages} current={stage} finished={finished} />
      {asking && <p className="text-[13px] text-foreground">{approval.question}</p>}
    </LiveActivity>
  );
}

/* ── 2. ETA with a mini agent graph ── */

/** The graph of a run in miniature, left to right: the hue follows the path that is done, and only the running node pulses. */
export function MiniGraph({ nodes, className, label = "Agent graph", pulse = true }: { nodes: readonly GraphNode[]; className?: string; label?: string; /** The running node pings. Default true. */ pulse?: boolean }) {
  const { pos, edges } = layoutGraph(nodes);
  const done = (id: string) => nodes.find((n) => n.id === id)?.state === "done";
  return (
    <div role="img" aria-label={`${label}: ${nodes.map((n) => `${n.label ?? n.id} ${n.state}`).join(", ")}`} className={cn("relative h-24 w-full", className)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
        {edges.map(([a, b]) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          const on = done(a);
          return <line key={`${a}-${b}`} x1={p.x * 100} y1={p.y * 100} x2={q.x * 100} y2={q.y * 100} vectorEffect="non-scaling-stroke" strokeWidth="2" className={cn("transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", on ? "" : "stroke-foreground/20")} style={on ? { stroke: "var(--kn-accent, var(--primary))" } : undefined} />;
        })}
      </svg>
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        return (
          <span
            key={n.id}
            className={cn("absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)", n.state === "queued" && "bg-foreground/25", n.state === "failed" && "bg-red-500")}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, ...(n.state === "done" || n.state === "running" ? { background: "var(--kn-accent, var(--primary))", } : {}) }}
          >
            {n.state === "running" && pulse && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: "var(--kn-accent, var(--primary))" }} />}
          </span>
        );
      })}
    </div>
  );
}

export interface EtaActivityProps extends Base {
  /** Minutes left, a best guess. 0 reads as done. */
  etaMinutes: number;
  /** The run's graph, in miniature, on the right third of the card. */
  graph?: readonly GraphNode[];
  /** Shown under the title. Default the ETA in words. */
  detail?: ReactNode;
}

/** How long a run has left as a big number that rolls, with the run's graph on the right third of the card. */
export function EtaActivity({ agent, leading, logo, title, etaMinutes, graph, detail, accent = ACCENT.eta, defaultExpanded = true, ...rest }: EtaActivityProps) {
  const done = etaMinutes <= 0;
  const finishedN = graph?.filter((n) => n.state === "done").length ?? 0;
  const running = graph?.find((n) => n.state === "running");
  return (
    <LiveActivity
      {...rest}
      accent={accent}
      defaultExpanded={defaultExpanded}
      leading={lead(agent, leading, accent, logo)}
      title={title ?? agent}
      subtitle={detail ?? etaWords(etaMinutes)}
      state={done ? "finished" : "busy"}
      bigValue
      trailing={done ? "Done" : <AnimatedNumber value={Math.ceil(etaMinutes)} />}
      valueLabel={done ? undefined : "min left"}
    >
      {graph && graph.length > 0 ? (
        <div className="grid grid-cols-3 items-center gap-3">
          <div className="col-span-2 text-[13px] text-muted-foreground">
            <p className="text-foreground">{finishedN} of {graph.length} steps done</p>
            {running && <p>{running.label ?? running.id} is running</p>}
          </div>
          <MiniGraph nodes={graph} pulse={rest.pulse ?? true} />
        </div>
      ) : undefined}
    </LiveActivity>
  );
}

/* ── 3. Budget as thin ticks ── */

export interface BudgetTicksActivityProps extends Base {
  /** What has been used, and the whole budget, in the same unit. */
  used: number;
  budget: number;
  /** Words for the unit: "tokens", "min", "$". Default "tokens". */
  unit?: string;
  /** Text for a figure. Default the locale's number format. */
  format?: (n: number) => string;
  /** A soft limit, in the same unit: drawn as a marker on the ticks. */
  softLimit?: number;
}

/** A token or time budget as the share bar's thin ticks: the fill is the accent, turns amber past 80% and red over budget. */
export function BudgetTicksActivity({ agent, leading, logo, title, used, budget, unit = "tokens", format, softLimit, accent, defaultExpanded = true, ...rest }: BudgetTicksActivityProps) {
  const fraction = budget > 0 ? used / budget : 0;
  const tone = used > budget ? "critical" : budgetTone(1 - fraction);
  const color = accent ?? TONE_COLOR[tone];
  const fmt = format ?? fmtNum;
  const left = Math.max(0, budget - used);
  return (
    <LiveActivity
      {...rest}
      accent={color}
      defaultExpanded={defaultExpanded}
      leading={lead(agent, leading, color, logo)}
      title={title ?? agent}
      subtitle={used > budget ? `Over budget by ${fmt(used - budget)} ${unit}` : `${fmt(left)} ${unit} left`}
      state={used > budget ? "failed" : tone === "ok" ? "busy" : "blocked"}
      bigValue
      trailing={<AnimatedNumber value={Math.round(fraction * 100)} suffix="%" />}
      valueLabel="used"
    >
      <div className="relative pt-1">
        <ActivityTicks value={fraction} color={color} label={`${unit} used`} />
        {softLimit !== undefined && budget > 0 && <span aria-hidden="true" className="absolute top-0 h-5 w-px bg-foreground/60" style={{ left: `${Math.min(100, (softLimit / budget) * 100)}%` }} />}
      </div>
      <div className="flex justify-between text-[12px] text-muted-foreground tabular-nums">
        <span>{fmt(used)} used</span>
        <span>
          {fmt(budget)} {unit}
        </span>
      </div>
    </LiveActivity>
  );
}

/* ── 4. Budget-left ring ── */

/** A ring that shows what is left of `total`, drawn with stroke-dashoffset on the slow token. */
export function BudgetRing({ left, total, size = 44, className }: { left: number; total: number; size?: number; className?: string }) {
  const fraction = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
  const color = TONE_COLOR[budgetTone(fraction)];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={`${Math.round(fraction * 100)}% left`} className={cn("-rotate-90", className)}>
      <circle cx="16" cy="16" r="12.5" fill="none" strokeWidth="4" className="stroke-foreground/15" />
      <circle cx="16" cy="16" r="12.5" fill="none" strokeWidth="4" strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={ringOffset(fraction)} className="transition-[stroke-dashoffset,stroke] duration-(--kn-dur-slow) ease-(--kn-ease-inout) motion-reduce:transition-none" style={{ stroke: color }} />
    </svg>
  );
}

export interface BudgetRingActivityProps extends Omit<Base, "leading" | "logo"> {
  /** What is left and the whole budget, in the same unit. */
  left: number;
  total: number;
  unit?: string;
  format?: (n: number) => string;
}

/** What is left of a budget: a 44px ring in the leading slot and the number, big, with "left" beside it. */
export function BudgetRingActivity({ agent, title, left, total, unit = "tokens", format, accent, ...rest }: BudgetRingActivityProps) {
  const fraction = total > 0 ? left / total : 0;
  const tone = left <= 0 ? "critical" : budgetTone(fraction);
  const fmt = format ?? fmtNum;
  return (
    <LiveActivity
      {...rest}
      accent={accent ?? TONE_COLOR[tone]}
      leadingSize="lg"
      leading={<BudgetRing left={left} total={total} />}
      title={title ?? agent}
      subtitle={`of ${fmt(total)} ${unit}`}
      state={left <= 0 ? "failed" : tone === "ok" ? "busy" : "blocked"}
      bigValue
      trailing={<AnimatedNumber value={Math.max(0, Math.round(left))} format={format ? (n) => format(n) : undefined} />}
      valueLabel="left"
    />
  );
}

/* ── 5. Voice: waveform and tokens per second ── */

/** A row of thin bars at `levels` (0 to 1), in the capsule's accent. Each bar changes height only when a new level arrives (120ms); with no new levels nothing moves. */
export function Waveform({ levels, bars = 16, className, label }: { levels: readonly number[]; bars?: number; className?: string; label?: string }) {
  const shown = waveBars(levels, bars);
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("flex h-5 items-center gap-[2px]", className)}>
      {shown.map((l, i) => (
        <span key={i} className="h-full w-[3px] origin-center rounded-full transition-transform duration-(--kn-dur-fast) ease-(--kn-ease-out) motion-reduce:transition-none" style={{ background: "var(--kn-accent, currentColor)", transform: `scaleY(${Math.max(0.12, l)})` }} />
      ))}
    </span>
  );
}

export interface VoiceActivityProps extends Base {
  /** Who is talking: the waveform and the dot follow it. */
  mode: "listening" | "speaking" | "idle";
  /** Recent loudness, 0 to 1, newest last. Push a new array as audio arrives. */
  levels: readonly number[];
  /** How fast the model is producing tokens. */
  tokensPerSecond?: number;
  /** The call's clock, already formatted ("04:12"), or leave it out. */
  elapsed?: string;
}

const VOICE_WORD = { listening: "Listening", speaking: "Speaking", idle: "On hold" } as const;

/** A voice agent on a call: an accent waveform that follows the audio, and the tokens per second it is producing, big. */
export function VoiceActivity({ agent, leading, logo, title, mode, levels, tokensPerSecond, elapsed, accent = ACCENT.voice, ...rest }: VoiceActivityProps) {
  return (
    <LiveActivity
      {...rest}
      accent={accent}
      leading={lead(agent, leading, accent, logo)}
      title={title ?? agent}
      subtitle={
        <span className="flex items-center gap-2">
          <Waveform levels={mode === "idle" ? [] : levels} label={VOICE_WORD[mode]} />
          <SwapText value={mode}>{VOICE_WORD[mode]}</SwapText>
        </span>
      }
      state={mode === "idle" ? "idle" : "busy"}
      bigValue
      trailing={tokensPerSecond !== undefined ? <AnimatedNumber value={Math.round(tokensPerSecond)} /> : elapsed}
      valueLabel={tokensPerSecond !== undefined ? "tok/s" : undefined}
    />
  );
}

/* ── 6. Handoff between agents ── */

export interface HandoffActivityProps extends Omit<Base, "agent" | "leading" | "logo" | "title"> {
  from: string;
  to: string;
  /** Marks for the two avatars, as `logo` on the other capsules. */
  fromLogo?: ReactNode;
  toLogo?: ReactNode;
  /** When the handoff happens on its own. */
  endsAt: Date;
  totalMs: number;
  now?: Date;
  /** Hand off now. */
  onHandoff?: () => void;
  /** Keep the work with the first agent. */
  onCancel?: () => void;
  /** Called once when the time runs out. */
  onDone?: () => void;
}

/** "Handoff to Checker" with a big "22s": two avatars, ticks that drain, and round buttons to act before it fires. */
export function HandoffActivity({ from, to, fromLogo, toLogo, endsAt, totalMs, now, onHandoff, onCancel, onDone, accent = ACCENT.handoff, defaultExpanded = true, ...rest }: HandoffActivityProps) {
  const [tick, setTick] = useState(() => (now ? now.getTime() : Date.now()));
  const left = Math.max(0, endsAt.getTime() - (now ? now.getTime() : tick));
  useEffect(() => {
    if (now || left <= 0) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now, left <= 0]);
  const done = left <= 0;
  useEffect(() => {
    if (done) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const ring = "ring-card";
  return (
    <LiveActivity
      {...rest}
      accent={accent}
      defaultExpanded={defaultExpanded}
      leading={
        fromLogo || toLogo ? (
          // With marks: the receiving agent large, the sender as a small mark on its corner.
          <span className="relative inline-grid">
            <Avatar label={to} icon={markOf(toLogo)} initials={to.charAt(0).toUpperCase()} hue={accent} size="md" shape="circle" />
            <span
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 grid size-4 place-items-center overflow-hidden rounded-full bg-card text-foreground ring-2 ring-card [&_svg]:size-[11px] [&>span]:size-[11px]"
            >
              {markOf(fromLogo) ?? <span className="text-[8px] leading-none font-semibold">{from.charAt(0).toUpperCase()}</span>}
            </span>
          </span>
        ) : (
          <span className="flex -space-x-1.5">
            <span className={cn("rounded-full ring-2", ring)}>
              <Avatar label={from} initials={from.charAt(0).toUpperCase()} size="xs" shape="circle" />
            </span>
            <span className={cn("rounded-full ring-2", ring)}>
              <Avatar label={to} initials={to.charAt(0).toUpperCase()} hue={accent} size="xs" shape="circle" />
            </span>
          </span>
        )
      }
      title={done ? `Handed off to ${to}` : `Handoff to ${to}`}
      subtitle={`from ${from}`}
      state={done ? "finished" : "blocked"}
      bigValue
      trailing={<time aria-label={spokenClock(left)}>{shortClock(left)}</time>}
      valueLabel={done ? undefined : "to go"}
      actions={
        !done && (onHandoff || onCancel) ? (
          <>
            {onHandoff && (
              <Button size="sm" variant="primary" className="rounded-full" onClick={onHandoff}>
                Hand off now
              </Button>
            )}
            {onCancel && (
              <Button size="sm" variant="secondary" className="rounded-full" onClick={onCancel}>
                Keep with {from}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <ActivityTicks clock value={totalMs > 0 ? left / totalMs : 0} label="Time until handoff" />
    </LiveActivity>
  );
}
