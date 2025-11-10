<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { ref, onErrorCaptured, shallowRef } from "vue";
const error = shallowRef<Error | null>(null);
const errorInfo = ref<string>("");
// Capture errors from child components
onErrorCaptured((err: Error, instance, info) => {
    console.error("Error captured by ErrorBoundary:", err);
    console.error("Error info:", info);
    console.error("Component instance:", instance);
    error.value = err;
    errorInfo.value = info;
    // Return false to prevent the error from propagating further
    return false;
});
function reset() {
    error.value = null;
    errorInfo.value = "";
}
</script>

<template>
    <div v-if="error" class="error-boundary">
        <div class="error-container">
            <div class="error-icon">
                <svg viewBox="0 0 24 24" width="64" height="64">
                    <circle
                        cx="12"
                        cy="12"
                        r="10"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    />
                    <path
                        d="M12 7v6M12 17h.01"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                    />
                </svg>
            </div>
            <h1>Error: {{ error.message }}</h1>
            <div class="error-details">
                <div class="detail-section">
                    <h3>Error Details</h3>
                    <pre>{{ error.stack || error.message }}</pre>
                </div>
                <div v-if="errorInfo" class="detail-section">
                    <h3>Component Info</h3>
                    <pre>{{ errorInfo }}</pre>
                </div>
            </div>
            <div class="error-actions">
                <button class="primary" @click="reset">Try Again</button>
            </div>
        </div>
    </div>
    <slot v-else></slot>
</template>

<style scoped lang="scss">
.error-boundary {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: #222;
    padding: 2rem;
    overflow: auto;
}

.error-container {
    max-width: 600px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    color: #ddd;
}

.error-icon {
    color: #e74c3c;
    margin-bottom: 1.5rem;
    animation: error-shake 0.5s ease-in-out;
}

@keyframes error-shake {
    0%,
    100% {
        transform: translateX(0);
    }
    10%,
    30%,
    50%,
    70%,
    90% {
        transform: translateX(-5px);
    }
    20%,
    40%,
    60%,
    80% {
        transform: translateX(5px);
    }
}

h1 {
    font-size: 2rem;
    font-weight: 500;
    color: #ddd;
    margin: 0 0 1rem 0;
    text-align: center;
}

.error-message {
    color: #aaa;
    text-align: center;
    margin: 0 0 2rem 0;
    padding: 1rem;
    background-color: #333;
    border-radius: 0.5rem;
    border-left: 4px solid #e74c3c;
    width: 100%;
    font-family: "Consolas", "Monaco", "Courier New", monospace;
}

.error-actions {
    display: flex;
    gap: 1rem;
    margin-bottom: 2rem;
    flex-wrap: wrap;
    justify-content: center;

    button {
        padding: 0.75rem 1.5rem;
        border: none;
        border-radius: 0.5rem;
        font-size: 1rem;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.2s ease;

        &.primary {
            background-color: #3498db;
            color: white;

            &:hover {
                background-color: #2980b9;
            }

            &:active {
                transform: scale(0.98);
            }
        }

        &.secondary {
            background-color: #555;
            color: #ddd;

            &:hover {
                background-color: #666;
            }

            &:active {
                transform: scale(0.98);
            }
        }
    }
}

.error-details {
    width: 100%;
    margin-top: 1rem;
    animation: fade-in 0.3s ease-in-out;
}

@keyframes fade-in {
    from {
        opacity: 0;
        transform: translateY(-10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.detail-section {
    margin-bottom: 1.5rem;

    h3 {
        color: #aaa;
        font-size: 0.9rem;
        font-weight: 500;
        text-transform: uppercase;
        margin: 0 0 0.5rem 0;
        letter-spacing: 0.05em;
    }

    pre {
        background-color: #1a1a1a;
        color: #e74c3c;
        padding: 1rem;
        border-radius: 0.5rem;
        overflow-x: auto;
        font-size: 0.85rem;
        line-height: 1.5;
        margin: 0;
        font-family: "Consolas", "Monaco", "Courier New", monospace;
        white-space: pre-wrap;
        word-break: break-word;
    }
}
</style>
