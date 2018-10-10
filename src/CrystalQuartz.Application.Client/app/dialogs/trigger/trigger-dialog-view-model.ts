﻿import {IDialogViewModel} from '../dialog-view-model';

import {Job,} from '../../api';
import {CommandService} from '../../services';
import {AddTriggerCommand, IAddTrackerForm} from '../../commands/trigger-commands';
import {JobDataMapItem} from '../common/job-data-map';

import __some from 'lodash/some';
import __map from 'lodash/map';
import __each from 'lodash/each';

import IDisposable = js.IDisposable;

export class ValidatorViewModel<T> implements IDisposable {
    private _errors = new js.ObservableValue<string[]>();
    private _disposables: IDisposable[] = [];

    dirty = new js.ObservableValue<boolean>();
    errors: js.IObservable<string[]>;
    validated = new js.ObservableValue<{ data: T, errors: string[] }>();

    constructor(
        forced: js.IObservable<boolean>,

        public key: any,
        public source: js.IObservable<T>,
        public validators: IValidator<T>[],
        private condition: js.IObservable<boolean>) {

        var conditionErrors = condition ?
            this.registerDisposable(
                js.dependentValue(
                    (validationAllowed: boolean, errors: string[]) => validationAllowed ? errors : [],
                    condition,
                    this._errors)) :
            this._errors;

        this.errors = this.registerDisposable(js.dependentValue(
            (isDirty: boolean, isForced: boolean, errors: string[]) => {

                console.log(this.key, isDirty, isForced, errors);

                if (isForced || isDirty) {
                    return errors;
                }

                return [];
            },
            this.dirty,
            forced,
            conditionErrors));

        this.registerDisposable(source.listen(
            (value, oldValue, data) => {
                console.log('source changed', value, oldValue, data);

                //if (data.reason !== js.DataChangeReason.initial) {
                    var actualErrors = [];
                    for (var i = 0; i < validators.length; i++) {
                        const errors = validators[i](value);
                        if (errors) {
                            for (var j = 0; j < errors.length; j++) {
                                actualErrors.push(errors[j]);
                            }
                        }
                    }

                    this._errors.setValue(actualErrors);
                //}

                this.validated.setValue({ data: value, errors: this._errors.getValue() || [] });
            }));
    }

    reset() {
        this._errors.setValue([]);
    }

    makeDirty() {
        this.dirty.setValue(true);
    }

    hasErrors() {
        const errors = this.errors.getValue();
        return errors && errors.length > 0;
    }

    dispose() {
        console.log('dispose validators model', this);

        for (let i = 0; i < this._disposables.length; i++) {
            this._disposables[i].dispose();
        }
    }

    private registerDisposable<T extends IDisposable>(item: T): T {
        this._disposables.push(item);
        return item;
    }
}

interface ValidatorOptions<T> {
    source: js.IObservable<T>;
    key?: any;
    condition?: js.IObservable<boolean>;
}

interface IValidator<T> {
    (value: T): string[] | undefined;
}

export class Validators implements IDisposable {
    private _forced = new js.ObservableValue<boolean>();

    public validators: ValidatorViewModel<any>[] = [];

    constructor() {
        this._forced.listen(x => console.log('forced', x));
    }

    register<T>(
        options: ValidatorOptions<T>,
        ...validators: IValidator<T>[]) {

        const result = new ValidatorViewModel<T>(
            this._forced,
            options.key || options.source,
            options.source,
            validators,
            options.condition);

        this.validators.push(result);

        return result;
    }

    findFor(key: any) {
        for (var i = 0; i < this.validators.length; i++) {
            if (this.validators[i].key === key) {
                return this.validators[i];
            }
        }

        return null;
    }

    validate() {
        this._forced.setValue(true);
        return !__some(this.validators, v => v.hasErrors());
    }

    dispose() {
        __each(this.validators, x => x.dispose());
    }
}

function map<T, U>(source: js.IObservable<T>, func: (value: T) => U) {
    return js.dependentValue(func, source);
}

class ValidatorsFactory {
    static required<T>(message: string) {
        return (value: T) => {
            if (!value) {
                return [message];
            }

            return [];
        }
    }

    static isInteger<T>(message: string) {
        return (value: T) => {
            if (value === null || value === undefined) {
                return [];
            }

            const rawValue = value.toString();

            for (var i = 0; i < rawValue.length; i++) {
                const char = rawValue.charAt(i);
                if (char < '0' || char > '9') {
                    return [message];
                }
            }

            return [];
        }
    }
}

export default class TriggerDialogViewModel implements IDialogViewModel<any>, js.IViewModel {
    accepted = new js.Event<any>(); /* todo: base class */
    canceled = new js.Event<any>();

    triggerName = js.observableValue<string>();
    triggerType = js.observableValue<string>();
    cronExpression = js.observableValue<string>();
    repeatForever = js.observableValue<boolean>();
    repeatCount = js.observableValue<string>();
    repeatInterval = js.observableValue<string>();
    repeatIntervalType = js.observableValue<string>();

    jobDataMap = new js.ObservableList<JobDataMapItem>();

    isSaving = js.observableValue<boolean>();

    newJobDataKey = new js.ObservableValue<string>();
    canAddJobDataKey: js.ObservableValue<boolean>;

    validators = new Validators();

    constructor(
        private job: Job,
        private commandService: CommandService) {

        const isSimpleTrigger = map(this.triggerType, x => x === 'Simple');

        this.validators.register(
            {
                source: this.cronExpression,
                condition: map(this.triggerType, x => x === 'Cron')
            },
            ValidatorsFactory.required('Please enter cron expression'));

        this.validators.register(
            {
                source: this.repeatCount,
                condition: js.dependentValue(
                    (isSimple: boolean, repeatForever: boolean) => isSimple && !repeatForever,
                    isSimpleTrigger, this.repeatForever)
            },
            ValidatorsFactory.required('Please enter repeat count'),
            ValidatorsFactory.isInteger('Please enter an integer number'));

        this.validators.register(
            {
                source: this.repeatInterval,
                condition: isSimpleTrigger
            },
            ValidatorsFactory.required('Please enter repeat interval'),
            ValidatorsFactory.isInteger('Please enter an integer number'));

        const newJobDataKeyValidationModel = this.validators.register(
            {
                source: this.newJobDataKey
            },
            (value: string) => {
                if (value && __some(this.jobDataMap.getValue(), x => x.key === value)) {
                    return ['Key ' + value + ' has already been added']
                }

                return null;
            });

        this.canAddJobDataKey = map(newJobDataKeyValidationModel.validated, x => x.data && x.data.length > 0 && x.errors.length === 0);
    }

    addJobDataMapItem() {
        const
            jobDataMapItem = new JobDataMapItem(this.newJobDataKey.getValue()),
            removeWire = jobDataMapItem.onRemoved.listen(() => {
                this.jobDataMap.remove(jobDataMapItem);
                this.newJobDataKey.setValue(this.newJobDataKey.getValue());

                removeWire.dispose();
            });

        this.jobDataMap.add(jobDataMapItem);
        this.newJobDataKey.setValue('');
    }

    cancel() {
        const hasDataEntered = this.repeatCount.getValue() ||
            this.repeatInterval.getValue() ||
            this.cronExpression.getValue();

        if (!hasDataEntered || confirm('Close trigger dialog?')) {
            this.canceled.trigger();
        }
    }

    save() {
        if (!this.validators.validate()) {
            return false;
        }

        var form: IAddTrackerForm = {
            name: this.triggerName.getValue(),
            job: this.job.Name,
            group: this.job.GroupName,
            triggerType: this.triggerType.getValue(),
            jobDataMap: __map(this.jobDataMap.getValue(), x => ({ key: x.key, value: x.value.getValue() }))
        };

        if (this.triggerType.getValue() === 'Simple') {
            var repeatForever = this.repeatForever.getValue();

            form.repeatForever = repeatForever;

            if (!repeatForever) {
                form.repeatCount = +this.repeatCount.getValue();
            }

            var repeatInterval = +this.repeatInterval.getValue();

            form.repeatInterval = repeatInterval * this.getIntervalMultiplier();

        } else if (this.triggerType.getValue() === 'Cron') {
            form.cronExpression = this.cronExpression.getValue();
        }

        this.isSaving.setValue(true);
        this.commandService
            .executeCommand(new AddTriggerCommand(form))
            .then(() => {
                this.accepted.trigger(true);
            })
            .always(() => {
                this.isSaving.setValue(false);
            })
            .fail((reason) => {
                /* todo */
            });

        return true;
    }

    releaseState() {
        this.validators.dispose();
    }

    private getIntervalMultiplier() {
        var intervalCode = this.repeatIntervalType.getValue();

        if (intervalCode === 'Seconds') {
            return 1000;
        }

        if (intervalCode === 'Minutes') {
            return 1000 * 60;
        }

        if (intervalCode === 'Hours') {
            return 1000 * 60 * 60;
        }

        if (intervalCode === 'Days') {
            return 1000 * 60 * 60 * 24;
        }

        return 1;
    }
}