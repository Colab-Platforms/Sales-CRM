// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/recording-playback.test.ts
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

// A minimal stand-in for the browser's Audio: records what was played / paused and lets the test fire its events.
class FakeAudio {
  static instances: FakeAudio[] = [];
  static playing = new Set<FakeAudio>();
  static maxConcurrent = 0;
  src = "";
  currentTime = 0;
  duration = 90;
  volume = 1;
  preload = "";
  private handlers = new Map<string, (() => void)[]>();
  constructor() {
    FakeAudio.instances.push(this);
  }
  addEventListener(name: string, fn: () => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  emit(name: string) {
    for (const fn of this.handlers.get(name) ?? []) fn();
  }
  async play() {
    FakeAudio.playing.add(this);
    FakeAudio.maxConcurrent = Math.max(FakeAudio.maxConcurrent, FakeAudio.playing.size);
    this.emit("play");
  }
  pause() {
    FakeAudio.playing.delete(this);
    this.emit("pause");
  }
  removeAttribute() {
    this.src = "";
  }
  load() {}
}
(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;

let store: typeof import("./recording-playback");

describe("shared recording playback", () => {
  before(async () => {
    store = await import("./recording-playback");
  });
  beforeEach(() => {
    store.resetPlaybackForTests();
    FakeAudio.instances = [];
    FakeAudio.playing.clear();
    FakeAudio.maxConcurrent = 0;
  });

  it("uses one audio element for every row and never plays two recordings at once", () => {
    for (let i = 0; i < 50; i++) store.playRecording(`call-${i}`, `https://rec.callerdesk.io/${i}.mp3`);
    assert.equal(FakeAudio.instances.length, 1, "a single audio element for the whole table");
    assert.equal(FakeAudio.maxConcurrent, 1, "at most one recording playing at any moment");
    assert.equal(store.getPlaybackState().activeId, "call-49");
    assert.equal(FakeAudio.instances[0]!.src, "https://rec.callerdesk.io/49.mp3");
  });

  it("starting another recording pauses the current one and resets the timeline", () => {
    store.playRecording("a", "https://x/a.mp3");
    const audio = FakeAudio.instances[0]!;
    audio.currentTime = 42;
    audio.emit("timeupdate");
    assert.equal(store.getPlaybackState().current, 42);
    store.playRecording("b", "https://x/b.mp3");
    assert.equal(store.getPlaybackState().activeId, "b");
    assert.equal(store.getPlaybackState().current, 0);
    assert.equal(store.getPlaybackState().playing, true);
  });

  it("toggle pauses the active recording and resumes it without restarting", () => {
    store.togglePlayback("a", "https://x/a.mp3");
    assert.equal(store.getPlaybackState().playing, true);
    store.togglePlayback("a", "https://x/a.mp3");
    assert.equal(store.getPlaybackState().playing, false);
    assert.equal(store.getPlaybackState().activeId, "a", "paused, still the active (expanded) one");
    store.togglePlayback("a", "https://x/a.mp3");
    assert.equal(store.getPlaybackState().playing, true);
    assert.equal(FakeAudio.instances[0]!.src, "https://x/a.mp3");
  });

  it("when playback finishes the player collapses (no active recording)", () => {
    store.playRecording("a", "https://x/a.mp3");
    FakeAudio.instances[0]!.emit("ended");
    assert.equal(store.getPlaybackState().activeId, null);
    assert.equal(store.getPlaybackState().playing, false);
    assert.equal(FakeAudio.playing.size, 0);
  });

  it("a row that unmounts (page change / filter / navigation) stops only its own playback", () => {
    store.playRecording("a", "https://x/a.mp3");
    store.stopPlaybackIf("someone-else");
    assert.equal(store.getPlaybackState().activeId, "a");
    store.stopPlaybackIf("a");
    assert.equal(store.getPlaybackState().activeId, null);
    assert.equal(FakeAudio.playing.size, 0);
  });

  it("reports the real duration once known, supports seeking and keeps the volume across recordings", () => {
    store.playRecording("a", "https://x/a.mp3");
    FakeAudio.instances[0]!.emit("loadedmetadata");
    assert.equal(store.getPlaybackState().duration, 90);
    store.seekPlayback(30);
    assert.equal(FakeAudio.instances[0]!.currentTime, 30);
    store.seekPlayback(500); // clamped to the end
    assert.equal(FakeAudio.instances[0]!.currentTime, 90);
    store.setPlaybackVolume(0.4);
    store.playRecording("b", "https://x/b.mp3");
    assert.equal(FakeAudio.instances[0]!.volume, 0.4);
    assert.equal(store.getPlaybackState().volume, 0.4);
  });

  it("a failing recording shows an error and does not keep playing", () => {
    store.playRecording("a", "https://x/a.mp3");
    FakeAudio.instances[0]!.emit("error");
    assert.equal(store.getPlaybackState().playing, false);
    assert.match(store.getPlaybackState().error ?? "", /could not be played/);
  });
});
