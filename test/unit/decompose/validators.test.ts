import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd";
import { checkComplexity, checkCoverage, checkDependency, checkOverlap } from "../../../src/decompose/validators";
import type { DecomposeValidator } from "../../../src/decompose/validators";
import { validateStoryDecomposition } from "../../../src/decompose/builder";







