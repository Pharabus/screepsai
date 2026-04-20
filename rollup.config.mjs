import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/main.ts',
  external: ['lodash'],
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
    name: 'main',
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json' }),
  ],
};
