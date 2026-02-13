<script lang="ts">
import { ref } from "vue";
const action_singleton = ref<string | null>(null);

export function setAction(name: string | null = null) {
    action_singleton.value = name;
}
</script>

<script setup lang="ts">
const action = action_singleton;
</script>

<template>
    <div class="loading-overlay">
        <svg viewBox="0 0 24 24" style="width: 5em">
            <g class="spinner">
                <circle cx="12" cy="2.5" r="1.5" opacity=".14" />
                <circle cx="16.75" cy="3.77" r="1.5" opacity=".29" />
                <circle cx="20.23" cy="7.25" r="1.5" opacity=".43" />
                <circle cx="21.50" cy="12.00" r="1.5" opacity=".57" />
                <circle cx="20.23" cy="16.75" r="1.5" opacity=".71" />
                <circle cx="16.75" cy="20.23" r="1.5" opacity=".86" />
                <circle cx="12" cy="21.5" r="1.5" />
            </g>
        </svg>
        <div class="action" v-if="action !== null">{{ action }}</div>
    </div>
</template>

<style scoped>
.loading-overlay {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    background-color: #222;
    user-select: none;
}

.action {
    margin: 2em 0;
    color: #888;
}

.spinner {
    transform-origin: center;
    animation: spinner-animation 0.75s step-end infinite;
    fill: white;
}

@keyframes spinner-animation {
    8.3% {
        transform: rotate(30deg);
    }

    16.6% {
        transform: rotate(60deg);
    }

    25% {
        transform: rotate(90deg);
    }

    33.3% {
        transform: rotate(120deg);
    }

    41.6% {
        transform: rotate(150deg);
    }

    50% {
        transform: rotate(180deg);
    }

    58.3% {
        transform: rotate(210deg);
    }

    66.6% {
        transform: rotate(240deg);
    }

    75% {
        transform: rotate(270deg);
    }

    83.3% {
        transform: rotate(300deg);
    }

    91.6% {
        transform: rotate(330deg);
    }

    100% {
        transform: rotate(360deg);
    }
}
</style>
