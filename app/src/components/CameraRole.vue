<script setup lang="ts">
import { ROLE, THEME, type Role } from "@lib/camera";
import Badge from "./Badge.vue";
defineProps<{
    role?: Role;
}>();
</script>

<template>
    <Badge :color="role && THEME[role]">{{
        (role && ROLE[role]) ?? "Unknown"
    }}</Badge>
</template>
