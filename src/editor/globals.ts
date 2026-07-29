/**
 * The window-globals contract that generated baz scene TSX expects.
 *
 * Mirrors bazaar-vid's GlobalDependencyProvider + buildCompositeHeader: scenes
 * are written against `window.Remotion`, bare `React`, icon globals and a
 * RemotionGoogleFonts.loadFont shim. Anything we stub renders a harmless
 * placeholder rather than throwing — one unknown global must not kill a scene.
 */
import React from 'react';
import * as Remotion from 'remotion';
import * as RemotionShapes from '@remotion/shapes';
import { Icon as IconifyIconImpl } from '@iconify/react';

declare global {
  interface Window {
    React: typeof React;
    Remotion: typeof Remotion;
    RemotionShapes: typeof RemotionShapes;
    IconifyIcon: unknown;
    HeroiconsSolid: unknown;
    HeroiconsOutline: unknown;
    LucideIcons: unknown;
    Rough: unknown;
    BazaarAvatars: Record<string, string>;
    RemotionGoogleFonts: { loadFont: (family: string, opts?: { weights?: string[] }) => unknown };
    RemotionGoogleFontsLoaded?: Set<string>;
    NativeAudio: typeof Audio;
  }
}

/** Placeholder component for icon sets we don't bundle (heroicons, lucide). */
function placeholderIcon(name: string) {
  return function PlaceholderIcon(props: Record<string, unknown>) {
    return React.createElement('span', {
      ...props,
      'data-icon-stub': name,
      style: {
        display: 'inline-block',
        width: '1em',
        height: '1em',
        borderRadius: 2,
        background: 'currentColor',
        opacity: 0.35,
        ...(props.style as object | undefined),
      },
    });
  };
}

const iconProxy = () =>
  new Proxy({}, { get: (_t, name) => placeholderIcon(String(name)) });

/** Port of the header's RemotionGoogleFonts.loadFont shim — injects a <link>. */
function loadFontShim(family: string, opts?: { weights?: string[] }) {
  const w = window;
  w.RemotionGoogleFontsLoaded = w.RemotionGoogleFontsLoaded || new Set();
  const key = `${family}:${(opts?.weights || []).join(',')}`;
  if (!w.RemotionGoogleFontsLoaded.has(key)) {
    w.RemotionGoogleFontsLoaded.add(key);
    const fam = family.trim().replace(/\s+/g, '+');
    const weights = opts?.weights?.length ? `:wght@${opts.weights.join(';')}` : '';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${fam}${weights}&display=swap`;
    document.head.appendChild(link);
  }
  return {
    fontFamily: family,
    fonts: {},
    unicodeRanges: {},
    waitUntilDone: () => Promise.resolve(),
  };
}

export function installGlobals(): void {
  const w = window;
  w.NativeAudio = w.NativeAudio || w.Audio;
  w.React = React;
  w.Remotion = Remotion;
  w.RemotionShapes = RemotionShapes;
  w.IconifyIcon = IconifyIconImpl;
  w.HeroiconsSolid = iconProxy();
  w.HeroiconsOutline = iconProxy();
  w.LucideIcons = iconProxy();
  w.Rough = w.Rough || { canvas: () => ({ rectangle() {}, circle() {}, line() {} }) };
  w.BazaarAvatars = w.BazaarAvatars || {};
  w.RemotionGoogleFonts = { loadFont: loadFontShim };
}
