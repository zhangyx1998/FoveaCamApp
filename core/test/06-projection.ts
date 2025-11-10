#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Projector, __origin__ } from "core/Vision";
console.log("imported", { Projector }, "from", __origin__);

const img_p = [
    { x: -10, y: -10 },
    { x: -10, y: +10 },
    { x: +10, y: +10 },
    { x: +10, y: -10 },
];

const obj_p = img_p.map((p) => ({ x: p.x / 10, y: p.y / 10, z: 1 }));

const proj = await Projector.solve(img_p, obj_p);

console.log("Image Points", img_p);
console.log("Object Points", obj_p);

const { rvec, tvec } = proj;
console.log({ rvec, tvec });

console.log("Projected Image Points:", proj.obj2img(obj_p));
console.log("Projected Object Points:", proj.img2obj(img_p, 1.0));
