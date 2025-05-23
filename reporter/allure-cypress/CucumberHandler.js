const logger = require('../debug');
const { tagToLabel, tagToLink, exampleNumber } = require('../gherkinToLabel');

class CucumberHandler {
    constructor(reporter) {
        this.reporter = reporter;
        this.examplesStorage = [];
    }

    get isStateAvailable() {
        return globalThis && globalThis.testState;
    }

    get state() {
        if (!this.isStateAvailable) {
            return;
        }
        return globalThis.testState;
    }

    get feature() {
        return this.isNewFormat
            ? this.state.gherkinDocument.feature
            : this.state.feature;
    }

    get currentScenario() {
        if (!this.isStateAvailable) {
            return;
        }

        const findScenario = () => {
            const child = getScenarios(this.feature).find((child) =>
                this.state.pickle.astNodeIds.includes(
                    child.scenario && child.scenario.id
                )
            );

            return child && child.scenario;
        };

        return this.state.currentScenario || findScenario();
    }

    get currentRule() {
        if (!this.isStateAvailable) {
            return;
        }

        const currentScenarioId =
            this.currentScenario && this.currentScenario.id;

        if (!currentScenarioId) {
            return;
        }

        const hasScenarioById = (children = [], id) =>
            children.some(
                (child) => child.scenario && child.scenario.id === id
            );

        const featureChild = this.feature.children.find(
            (child) =>
                child &&
                child.rule &&
                hasScenarioById(child.rule.children, currentScenarioId)
        );

        if (!featureChild) {
            return;
        }

        return featureChild.rule;
    }

    get isNewFormat() {
        if (!this.isStateAvailable) {
            return;
        }
        return Boolean(this.state.gherkinDocument);
    }

    get outlineExampleIndex() {
        if (this.isNewFormat) {
            const [, exampleId] = this.state.pickle.astNodeIds;
            if (
                !this.currentScenario.examples ||
                !this.currentScenario.examples.length
            ) {
                return -1;
            }
            return this.currentScenario.examples[0].tableBody.findIndex(
                (item) => item.id === exampleId
            );
        }
        const num = parseInt(
            exampleNumber.exec(this.currentScenario.name).pop()
        );
        if (!num) {
            return -1;
        }
        return num - 1;
    }

    addTag(scenarioId, tag) {
        const currentTags = this.currentScenario.tags || [];
        if (this.isNewFormat) {
            const indexes = findScenarioIndexes(this.feature, scenarioId);

            // scenario not found
            if (indexes.child === -1) {
                return;
            }

            const newTags = [
                ...currentTags.filter((t) => !t.type && !t.type !== 'Tag'),
                tag
            ];

            // set tags for scenario under Rule keyword
            if (indexes.rule !== undefined && indexes.rule !== -1) {
                globalThis.testState.gherkinDocument.feature.children[
                    indexes.rule
                    ].rule.children[indexes.child].scenario.tags = newTags;
                return;
            }

            // set tags for scenario
            globalThis.testState.gherkinDocument.feature.children[
                indexes.child
                ].scenario.tags = newTags;
            return;
        }

        globalThis.testState.runScenarios[this.currentScenario.name].tags = [
            ...currentTags,
            tag
        ];
    }

    checkLinksInExamplesTable() {
        if (!this.isStateAvailable) {
            return;
        }

        const scenario = this.currentScenario;

        if (!scenario) {
            return;
        }

        if (scenario.keyword !== 'Scenario Outline') {
            return;
        }
        logger.allure(`populating gherkin links from examples table`);

        !this.examplesStorage.length &&
        this.examplesStorage.push(...scenario.examples);

        const example =
            this.examplesStorage.length && this.examplesStorage.pop();

        if (example) {
            const findCellIndex = (type) =>
                example.tableHeader.cells.findIndex(
                    (cell) => cell.value === type
                );

            const tmsCellIndex = findCellIndex('tms');
            const issueCellIndex = findCellIndex('issue');

            const exampleRowIndex = this.outlineExampleIndex;
            if (exampleRowIndex === -1) {
                return;
            }

            const findTableCellValue = (headerIndex) =>
                example.tableBody[exampleRowIndex].cells[headerIndex].value;

            if (tmsCellIndex !== -1) {
                const tmsId = findTableCellValue(tmsCellIndex);
                logger.allure(`found tms link: %s`, tmsId);
                this.addTag(this.currentScenario.id, {
                    type: 'Tag',
                    name: `@tms("${tmsId}")`
                });
            }

            if (issueCellIndex !== -1) {
                const issueId = findTableCellValue(issueCellIndex);
                logger.allure(`found issue link: %s`, issueId);
                this.addTag(this.currentScenario.id, {
                    type: 'Tag',
                    name: `@issue("${issueId}")`
                });
            }
        }
    }

    // accept cucumber tags from cypress-cucumber-preprocessor as commands
    checkTags() {
        if (!this.isStateAvailable) {
            return;
        }
        logger.allure(`parsing gherkin tags`);
        const { currentTest } = this.reporter;

        // set bdd feature by default
        currentTest.addLabel('feature', this.feature.name);

        /**
         * tags set on test level has higher priority
         * to not be overwritten by feature or rule tags
         */

        [this.feature, this.currentRule, this.currentScenario].forEach(
            (kind) => {
                if (!kind || !kind.tags || !kind.tags.length) {
                    return;
                }

                kind.tags
                    .filter(({ name }) => {
                        const match = tagToLabel.exec(name);
                        if (match) {
                            const [, command, value] = match;

                            if (command === 'testID') {
                                const ids = value.split('|');
                                const index = this.outlineExampleIndex ?? 0;
                                const id = ids[index] || ids[0];
                                this.reporter.currentTest.addLabel('AS_ID', id);
                            } else if (['feature', 'suite'].includes(command)) {
                                const labelIndex =
                                    this.reporter.currentTest.info.labels.findIndex(
                                        (label) => label.name === command
                                    );
                                this.reporter.currentTest.info.labels[
                                    labelIndex
                                    ] = {
                                    name: command,
                                    value
                                };
                            } else {
                                this.reporter.currentTest.addLabel(
                                    command,
                                    value
                                );
                            }
                        }
                        return !match;
                    })
                    .filter(({ name }) => {
                        const match = tagToLink.exec(name);
                        if (match) {
                            const [, command, name, matchUrl] = match;

                            const url = matchUrl || name;
                            const prefixBy = {
                                issue: Cypress.env('issuePrefix'),
                                tms: Cypress.env('tmsPrefix'),
                                link: null
                            };
                            const urlPrefix = prefixBy[command];

                            const pattern =
                                urlPrefix && urlPrefix.includes('*')
                                    ? urlPrefix
                                    : `${urlPrefix}*`;

                            this.reporter.currentTest.addLink(
                                urlPrefix && pattern
                                    ? pattern.replace(/\*/g, url)
                                    : url,
                                name,
                                command
                            );
                        }
                        return !match;
                    })
                    .forEach(({ name }) => {
                        this.reporter.currentTest.addLabel(
                            'tag',
                            name.replace('@', '')
                        );
                    });
            }
        );
    }
}

const getScenarios = (feature) => {
    const { children } = feature;

    return children.reduce((scenarios, child) => {
        const children = child && child.rule ? child.rule.children : [child];
        scenarios.push(...children);
        return scenarios;
    }, []);
};

// get object with index of rule and child scenario by id
const findScenarioIndexes = (feature, scenarioId) => {
    const { children } = feature;

    return children.reduce((indexes, child, index) => {
        const isRule = Boolean(child.rule);

        const children = isRule ? child.rule.children : [child];

        const matchIndex = children.findIndex(
            (child) => child.scenario && child.scenario.id === scenarioId
        );

        if (matchIndex === -1) {
            return indexes;
        }

        return isRule
            ? {
                rule: index,
                child: matchIndex
            }
            : {
                rule: -1,
                child: index
            };
    }, {});
};

const commandIsGherkinStep = (command) =>
    command &&
    command.args &&
    command.args.length &&
    command.args.length === 1 &&
    command.args[0] &&
    typeof command.args[0] === 'function' &&
    command.args[0].toString &&
    ['state.onStartStep', 'runStepWithLogGroup'].some((gherkinFn) =>
        command.args[0].toString().includes(gherkinFn)
    );

module.exports = {
    CucumberHandler,
    commandIsGherkinStep
};
