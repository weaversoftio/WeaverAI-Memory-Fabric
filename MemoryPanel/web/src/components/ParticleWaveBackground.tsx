/**
 * ParticleWaveBackground - a bright-style dot-matrix wave animated background (pure Canvas, zero external dependencies).
 *
 * Visual reference is React Bits' Particles / DotGrid: a grid of dots driven by multiple layers of sine waves,
 * with dot radius and opacity varying with the wave crest, forming a soft "breathing" ripple.
 *
 * Why not install the React Bits package directly:
 *   its Particles / DotGrid / Aurora depend on ogl / gsap / three respectively, none of which are installed in this project.
 *   It is implemented the way React Bits officially recommends, manually (copying the source into the project), avoiding new runtime dependencies
 *   and build risk while keeping fully controllable visual tuning.
 *
 * Implementation notes:
 *   - devicePixelRatio adaptation, to avoid blur on HiDPI screens;
 *   - ResizeObserver follows the container size and does not listen on window, to avoid multiple instances interfering with each other;
 *   - Respects prefers-reduced-motion: renders a single static frame and does not start rAF when reduced motion is preferred;
 *   - Cancels rAF and the observer on unmount, no memory leaks.
 */
import { useEffect, useRef } from 'react';

export interface ParticleWaveBackgroundProps {
  /** Dot grid spacing (px); smaller is denser. Default 26 */
  gap?: number;
  /** Base dot radius (px). Default 1.5 */
  dotRadius?: number;
  /** Dot color, must be in `r, g, b` form (opacity is computed internally from the wave crest). Default dark gray-blue */
  color?: string;
  /** Animation speed factor, default 1 */
  speed?: number;
  /** Extra class name */
  className?: string;
}

export default function ParticleWaveBackground({
  gap = 26,
  dotRadius = 1.5,
  color = '100, 116, 139',
  speed = 1,
  className,
}: ParticleWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let disposed = false;

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // Use setTransform instead of scale, to avoid the scale factor accumulating after repeated resizes
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Render one frame. Three sine waves of different frequency/phase are summed to give an intensity field in [-1, 1];
     * intensity is mapped to dot radius and opacity, forming a dot-matrix wave of light and dark undulation.
     *
     * Parameter note: the time factor determines "how fast it looks to move". If too small (<0.5) a single wave period can last
     * over ten seconds, and the eye can hardly tell it is moving, like a static image; here 0.65~1.15 is used so the main wave takes about 5 seconds
     * per period, clearly showing flow without being dazzling.
     */
    function draw(elapsedMs: number) {
      if (width <= 0 || height <= 0) return;
      const t = (elapsedMs / 1000) * speed;
      ctx!.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * gap;
          const y = row * gap;
          // Normalized coordinates keep the wave shape from deforming with canvas size
          const nx = x / Math.max(width, 1);
          const ny = y / Math.max(height, 1);

          // The main wave flows right to left, and the other two layers superimpose at different angles, avoiding regular stripes
          const wave =
            Math.sin(nx * 7.5 - t * 1.15) * 0.45 +
            Math.sin(ny * 5.5 + t * 0.75) * 0.28 +
            Math.sin((nx * 3.2 + ny * 4.1) + t * 0.95) * 0.27;

          // wave in about [-1, 1] -> intensity in [0, 1]
          const intensity = (wave + 1) / 2;
          // Power-law shrinking of dark parts makes crests stand out and troughs cleaner, giving clearer light/dark contrast
          const shaped = Math.pow(intensity, 1.4);
          // Slightly lighter at the top, slightly more solid at the bottom, enhancing the bright feel of "light coming from above"
          const depth = 0.6 + ny * 0.4;
          const alpha = (0.08 + shaped * 0.5) * depth;
          const radius = dotRadius * (0.45 + shaped * 1.15);
          if (alpha <= 0.01 || radius <= 0.05) continue;

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    function loop(now: number) {
      if (disposed) return;
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    }

    resize();

    const observer = new ResizeObserver(() => {
      resize();
      // When reduced motion is preferred rAF is not run; after a resize a frame must be redrawn manually
      if (reduceMotion) draw(0);
    });
    const parent = canvas.parentElement;
    if (parent) observer.observe(parent);

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [gap, dotRadius, color, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
