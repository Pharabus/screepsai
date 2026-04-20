import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const banner = `// screepsAI v${pkg.version} - built ${new Date().toISOString()}`;

export default {
  input: 'src/main.ts',
  external: ['lodash'],
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
    name: 'main',
    banner,
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json' }),
  ],
};
