<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { ref, shallowRef, Suspense } from "vue";
import TitleBar from "./components/TitleBar.vue";
import Controller from "./components/Controller.vue";
const currentModule = shallowRef<any>(null);
const currentModuleName = ref<string | null>(null);
const titleBarHeight = ref(0);
// Sub task modules
import DisparityScope from "../modules/disparity-scope/index.vue";
import ManageCameras from "../modules/manage-cameras/index.vue";
import CalibrateIntrinsic from "../modules/calibrate-intrinsic/index.vue";
import CalibrateExtrinsic from "../modules/calibrate-extrinsic/index.vue";
import Playground from "../modules/playground/index.vue";
import Loading from "./components/Loading.vue";

function launch(module: any, name: string) {
    currentModule.value = module;
    currentModuleName.value = name;
}

function backToHome() {
    currentModule.value = null;
    currentModuleName.value = null;
}
</script>

<template>
    <div class="main" :style="{ top: titleBarHeight + 'px' }">
        <template v-if="currentModule">
            <suspense>
                <component v-if="currentModule" :is="currentModule" />
                <template #fallback>
                    <Loading />
                </template>
            </suspense>
        </template>
        <div v-else class="main-menu">
            <div class="welcome">
                <img
                    src="/FoveaCam Duo Mini.png"
                    style="
                        width: max(40vw, 40vh, 80%);
                        margin: 3em;
                        max-width: 50vw;
                    "
                />
                <h1>FoveaCam Duo Mini</h1>
            </div>
            <div class="modules">
                <div class="group">
                    <h2>Applications</h2>
                    <button @click="launch(DisparityScope, 'Disparity Scope')">
                        Disparity Scope
                    </button>
                    <button>3D Tracking (Single)</button>
                    <button>3D Tracking (Multi)</button>
                    <button>3D Reconstruction</button>
                    <button @click="launch(Playground, 'Calibrate')">
                        Playground
                    </button>
                </div>
                <div class="group">
                    <h2>Utilities</h2>
                    <button @click="launch(ManageCameras, 'Manage Cameras')">
                        Manage Cameras
                    </button>
                    <button
                        @click="
                            launch(CalibrateIntrinsic, 'Calibrate - Intrinsic')
                        "
                    >
                        Calibrate - Intrinsic
                    </button>
                    <button
                        @click="
                            launch(CalibrateExtrinsic, 'Calibrate - Extrinsic')
                        "
                    >
                        Calibrate - Extrinsic
                    </button>
                    <button>Manage Calibrations</button>
                </div>
                <div style="flex-grow: 1"></div>
                <div class="footnote">Copyright © 2025 Yuxuan Zhang</div>
            </div>
        </div>
    </div>
    <TitleBar
        title="FoveaCam Duo"
        :subtitle="currentModuleName"
        @height="(h) => (titleBarHeight = h)"
        @back-to-home="backToHome"
    >
        <Controller />
    </TitleBar>
</template>

<style scoped lang="scss">
.main {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: auto;
    * {
        user-select: none;
    }
}

.main-menu {
    display: flex;
    flex-direction: row;
    align-items: center;
    overflow-y: scroll;
    width: 100%;
    height: 100%;

    h1 {
        font-size: 2rem;
        font-weight: 500;
        color: #666;
        width: 100%;
        text-align: center;
        margin: 0;
        padding: 0;
    }

    .welcome {
        height: 100%;
        flex-grow: 1;
        background-color: #333;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
    }

    .modules {
        background-color: #222;
        display: flex;
        height: 100%;
        flex-direction: column;
        justify-content: flex-start;
        min-width: 40ch;
        border-left: 1px solid #fff4;
        --color: white;
        .group {
            display: flex;
            flex-direction: column;
            padding: 0.5rem 0;
            margin: 0.5rem 0;
            &:not(:first-child) {
                border-top: 1px solid #fff4;
            }
            h2 {
                margin: 1rem 1.5rem;
                padding: unset;
                color: #aaa;
            }
        }

        button {
            font-size: 1.2em;
            padding: 0.5em 1em;
            background: none;
            border: none;
            color: #ddd;
            cursor: pointer;
            min-width: 12ch;
            text-align: left;
            font-family: inherit;
            border-left: 0.8ch solid transparent;

            &:hover {
                border-left: 0.8ch solid var(--color);
                color: var(--color);
                background-color: #fff1;
            }

            &:active {
                border-left: 0.8ch solid var(--color);
                background-color: #fff2;
            }
        }
    }
    .footnote {
        color: #666;
        text-align: center;
        padding: 1em 0;
    }
}
</style>
