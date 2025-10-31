// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export type BatchItem<T = any> = {
    input: T;
    output: number;
};

export type Batch<T = any> = BatchItem<T>[];

type Loss = {
    forward(pred: number, truth: number): number;
    backward(pred: number, truth: number): number;
};

export const MSE: Loss = {
    forward: (p: number, t: number) => (p - t) ** 2,
    backward: (p: number, t: number) => 2 * (p - t),
};

export const MAE: Loss = {
    forward: (p: number, t: number) => Math.abs(p - t),
    backward: (p: number, t: number) => Math.sign(p - t),
};

export interface Optimizer {
    update(params: Float64Array, grads: Float64Array, lr: number): void;
    reset(): void;
}

export class SGD implements Optimizer {
    update(params: Float64Array, grads: Float64Array, lr: number): void {
        for (let i = 0; i < params.length; i++) {
            params[i] -= lr * grads[i];
        }
    }
    reset(): void {}
}

export class Momentum implements Optimizer {
    private velocity: Float64Array | null = null;
    private beta: number;

    constructor(beta: number = 0.9) {
        this.beta = beta;
    }

    update(params: Float64Array, grads: Float64Array, lr: number): void {
        if (!this.velocity) {
            this.velocity = new Float64Array(params.length);
        }
        for (let i = 0; i < params.length; i++) {
            this.velocity[i] =
                this.beta * this.velocity[i] + (1 - this.beta) * grads[i];
            params[i] -= lr * this.velocity[i];
        }
    }

    reset(): void {
        this.velocity = null;
    }
}

export class Adam implements Optimizer {
    private m: Float64Array | null = null;
    private v: Float64Array | null = null;
    private t: number = 0;
    private beta1: number;
    private beta2: number;
    private epsilon: number;

    constructor(
        beta1: number = 0.9,
        beta2: number = 0.999,
        epsilon: number = 1e-8
    ) {
        this.beta1 = beta1;
        this.beta2 = beta2;
        this.epsilon = epsilon;
    }

    update(params: Float64Array, grads: Float64Array, lr: number): void {
        if (!this.m || !this.v) {
            this.m = new Float64Array(params.length);
            this.v = new Float64Array(params.length);
        }
        this.t++;

        for (let i = 0; i < params.length; i++) {
            // Update biased first moment estimate
            this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * grads[i];
            // Update biased second raw moment estimate
            this.v[i] =
                this.beta2 * this.v[i] + (1 - this.beta2) * grads[i] ** 2;
            // Compute bias-corrected first moment estimate
            const m_hat = this.m[i] / (1 - this.beta1 ** this.t);
            // Compute bias-corrected second raw moment estimate
            const v_hat = this.v[i] / (1 - this.beta2 ** this.t);
            // Update parameters
            params[i] -= (lr * m_hat) / (Math.sqrt(v_hat) + this.epsilon);
        }
    }

    reset(): void {
        this.m = null;
        this.v = null;
        this.t = 0;
    }
}

export abstract class Model<T> extends Float64Array {
    readonly loss: Loss;
    readonly lr: number;
    readonly optimizer: Optimizer;

    constructor(
        parameters: Iterable<number>,
        loss: Loss = MSE,
        lr: number = 1e-6,
        optimizer: Optimizer = new Adam()
    ) {
        super(parameters);
        this.loss = loss;
        this.lr = lr;
        this.optimizer = optimizer;
    }

    last_loss: number = Infinity;

    step(batch: Batch<T>) {
        const grads = new Float64Array(this.length);
        for (const { input, output } of batch) {
            const pred = this.predict(input);
            const grad = this.grad(input);
            this.last_loss = this.loss.forward(pred, output);
            const loss_grad = this.loss.backward(pred, output);
            for (let i = 0; i < grads.length; i++)
                grads[i] += loss_grad * grad[i];
        }
        // Average gradients over batch
        const scale = 1 / batch.length;
        for (let i = 0; i < grads.length; i++) {
            grads[i] *= scale;
        }
        // Apply gradients using optimizer
        this.optimizer.update(this, grads, this.lr);
    }
    async train(data: BatchItem[], epochs: number = 100) {
        for (let epoch = 0; epoch < epochs; epoch++) {
            await this.step(data);
            await new Promise(process.nextTick);
        }
        return this;
    }
    abstract predict(input: T): number;
    abstract grad(input: T): number[];
}
