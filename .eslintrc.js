
module.exports = {
    extends: [
        'eslint-config-google',
    ],
    "parserOptions": {
        "ecmaVersion": 2018
    },
    rules: {
        'no-invalid-this': 0,
        'one-var': 0,
        'prefer-rest-params': 0,
        'max-len': 0,
        'require-jsdoc': 0,
        'valid-jsdoc': 0,
        'comma-dangle': 0,
        'curly': 0,
        'arrow-parens': 0,

        // not yet es6, node_modules/eslint/bin/eslint.js --fix 
        'no-var': 1,

        'indent': ['error', 4, {
            // How chaining and related is not consistently formatted in this application. But there are too many
            // instances of incorrectness to fix (2010)
            MemberExpression: 'off',
            // This primarily occurs because of our old style of defining component specs with strings in arrays. Once
            // those are all shifted to template literals, this can be enabled (127 issues)
            ArrayExpression: 'off',
            // Commented out code does not need to follow indenting standards
            ignoreComments: true,
        }],
    },

    
}