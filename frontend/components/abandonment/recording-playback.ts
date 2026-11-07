"use client";

import { useSyncExternalStore } from "react";

// ONE audio element for the whole Abandoned Leads table. Every recording row is only a view onto it, so two recordings can never play at once:
// starting another one replaces the source of the same element. State is a plain subscribable store (no dependency); a row that is not the active
// one always reads the same frozen IDLE snapshot, so the ~4 updates a second while playing re-render only the active row.

export interface PlaybackState {
  activeId: string | null;
  playing: boolean;
  current: number;
  duration: number;
  volume: number;
  error: string | null;
}

const IDLE: PlaybackState = { activeId: null, playing: false, current: 0, duration: 0, volume: 1, error: null };
let state: PlaybackState = IDLE;
let volume = 1;
let audio: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<PlaybackState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function reset() {
  state = { ...IDLE, volume };
  listeners.forEach((l) => l());
}

function getAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "none";
  el.addEventListener("timeupdate", () => set({ current: el.currentTime }));
  el.addEventListener("loadedmetadata", () => set({ duration: Number.isFinite(el.duration) ? el.duration : 0 }));
  el.addEventListener("durationchange", () => set({ duration: Number.isFinite(el.duration) ? el.duration : 0 }));
  el.addEventListener("play", () => set({ playing: true, error: null }));
  el.addEventListener("pause", () => set({ playing: false }));
  // Finished: back to the collapsed state.
  el.addEventListener("ended", () => stopPlayback());
  el.addEventListener("error", () => {
    if (state.activeId) set({ playing: false, error: "This recording could not be played." });
  });
  audio = el;
  return el;
}

export function playRecording(id: string, url: string): void {
  const el = getAudio();
  if (state.activeId !== id) {
    el.pause(); // whatever was playing stops before the new one starts
    el.src = url;
    state = { ...IDLE, volume, activeId: id };
    listeners.forEach((l) => l());
  }
  el.volume = volume;
  void el.play().catch(() => set({ playing: false, error: "This recording could not be played." }));
}

export function togglePlayback(id: string, url: string): void {
  if (state.activeId === id && state.playing) audio?.pause();
  else playRecording(id, url);
}

export function seekPlayback(seconds: number): void {
  if (!audio || !state.activeId) return;
  audio.currentTime = Math.max(0, Math.min(seconds, state.duration || seconds));
  set({ current: audio.currentTime });
}

export function setPlaybackVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value));
  if (audio) audio.volume = volume;
  set({ volume });
}

/** Stops and releases the audio (collapses the active player). Safe to call when nothing is playing. */
export function stopPlayback(): void {
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  reset();
}

export function stopPlaybackIf(id: string): void {
  if (state.activeId === id) stopPlayback();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The playback state as seen by one recording: the live state when it is the active one, otherwise an unchanging idle value. */
export function usePlayback(id: string): PlaybackState {
  return useSyncExternalStore(
    subscribe,
    () => (state.activeId === id ? state : idleCache(state.volume)),
    () => IDLE,
  );
}

// A stable idle object per volume value (useSyncExternalStore needs the same reference while nothing changed).
let idleVolume = -1;
let idleObject: PlaybackState = IDLE;
function idleCache(v: number): PlaybackState {
  if (v !== idleVolume) {
    idleVolume = v;
    idleObject = { ...IDLE, volume: v };
  }
  return idleObject;
}

/** Test helper: forget everything, including the audio element. */
export function resetPlaybackForTests(): void {
  audio = null;
  volume = 1;
  state = IDLE;
  listeners.clear();
}

export function getPlaybackState(): PlaybackState {
  return state;
}
