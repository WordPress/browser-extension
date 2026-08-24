/**
 * Correctness-focused lint config. Deliberately no formatting rules: the
 * popup source uses tabs and the vanilla runtime files use two-space
 * indentation, both intentionally, and reformatting shipped code for style
 * is churn without safety value. The goal here is the bug class linting
 * actually catches (undefined globals, unused code, unsafe equality).
 */
const js = require( '@eslint/js' );
const globals = require( 'globals' );
const react = require( 'eslint-plugin-react' );
const reactHooks = require( 'eslint-plugin-react-hooks' );

module.exports = [
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'release/**',
			'safari/**',
			'safari-build/**',
			// App Store archive/export output (gitignored); the archived .app
			// carries copies of the bundles that are not lintable source.
			'build/**',
			'test/node_modules/**',
		],
	},
	js.configs.recommended,
	{
		files: [ '**/*.js', '**/*.mjs' ],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			parserOptions: { ecmaFeatures: { jsx: true } },
			globals: {
				...globals.browser,
				...globals.webextensions,
			},
		},
		plugins: { react, 'react-hooks': reactHooks },
		rules: {
			'no-unused-vars': [ 'error', { argsIgnorePattern: '^_', caughtErrors: 'none' } ],
			'no-empty': [ 'error', { allowEmptyCatch: true } ],
			'react/jsx-uses-vars': 'error',
			'react/jsx-uses-react': 'error',
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
		},
	},
	{
		// Background service worker: importScripts-loaded lib globals.
		files: [ 'background.js' ],
		languageOptions: {
			globals: {
				importScripts: 'readonly',
				WPMySites: 'readonly',
				WPRest: 'readonly',
				WPDetect: 'readonly',
			},
		},
	},
	{
		// Node contexts: build scripts, config, and the test harness.
		files: [
			'scripts/**/*.js',
			'test/**/*.js',
			'test/**/*.mjs',
			'eslint.config.js',
			'webpack.config.js',
		],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		// Carries a `typeof module !== 'undefined'` CommonJS shim for the
		// test harness; `module` is otherwise undefined in the browser.
		files: [ 'lib/site-info.js' ],
		languageOptions: {
			globals: { module: 'readonly' },
		},
	},
];
