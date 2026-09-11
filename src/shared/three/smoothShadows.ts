import * as THREE from "three";

const PCF_TARGET = `shadow = (
\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
\t\t\t\t) * 0.2;`;

const POINT_TARGET = `\t\t\tvec2 sample0 = vogelDiskSample( 0, 5, phi );
\t\t\tvec2 sample1 = vogelDiskSample( 1, 5, phi );
\t\t\tvec2 sample2 = vogelDiskSample( 2, 5, phi );
\t\t\tvec2 sample3 = vogelDiskSample( 3, 5, phi );
\t\t\tvec2 sample4 = vogelDiskSample( 4, 5, phi );
\t\t\tshadow = (
\t\t\t\ttexture( shadowMap, vec4( bd3D + ( tangent * sample0.x + bitangent * sample0.y ) * texelSize, dp ) ) +
\t\t\t\ttexture( shadowMap, vec4( bd3D + ( tangent * sample1.x + bitangent * sample1.y ) * texelSize, dp ) ) +
\t\t\t\ttexture( shadowMap, vec4( bd3D + ( tangent * sample2.x + bitangent * sample2.y ) * texelSize, dp ) ) +
\t\t\t\ttexture( shadowMap, vec4( bd3D + ( tangent * sample3.x + bitangent * sample3.y ) * texelSize, dp ) ) +
\t\t\t\ttexture( shadowMap, vec4( bd3D + ( tangent * sample4.x + bitangent * sample4.y ) * texelSize, dp ) )
\t\t\t) * 0.2;`;

let isPatched = false;

/**
 * Upgrades Three.js's built-in 5-tap PCF shadow shader to a high-density 32-tap Vogel disk filter.
 *
 * In standard Three.js, PCF shadows use only 5 samples jittered with Interleaved
 * Gradient Noise (IGN). When shadow softness / radius is increased, the 5 samples spread
 * widely apart across screen pixels, resulting in severe stippling / dither noise.
 *
 * Using 32 Vogel disk samples (effectively 128 hardware-interpolated bilinear taps) densely
 * populates the Vogel spiral, eliminating the grain and producing smooth, velvety diffuse shadows.
 */
export function enableSmoothShadows(sampleCount = 32): void {
  if (isPatched) return;
  const inv = (1.0 / sampleCount).toFixed(8);

  const pcfReplacement = `float shadowSum = 0.0;
\t\t\t\tfor ( int i = 0; i < ${sampleCount}; i ++ ) {
\t\t\t\t\tshadowSum += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${sampleCount}, phi ) * radius, shadowCoord.z ) );
\t\t\t\t}
\t\t\t\tshadow = shadowSum * ${inv};`;

  const pointReplacement = `float shadowSum = 0.0;
\t\t\tfor ( int i = 0; i < ${sampleCount}; i ++ ) {
\t\t\t\tvec2 s = vogelDiskSample( i, ${sampleCount}, phi );
\t\t\t\tshadowSum += texture( shadowMap, vec4( bd3D + ( tangent * s.x + bitangent * s.y ) * texelSize, dp ) );
\t\t\t}
\t\t\tshadow = shadowSum * ${inv};`;

  let chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (chunk.includes(PCF_TARGET)) {
    chunk = chunk.replace(PCF_TARGET, pcfReplacement);
  }
  if (chunk.includes(POINT_TARGET)) {
    chunk = chunk.replace(POINT_TARGET, pointReplacement);
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk;
  isPatched = true;
}
