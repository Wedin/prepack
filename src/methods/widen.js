/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Binding } from "../environment.js";
import { FatalError } from "../errors.js";
import type { Bindings, BindingEntry, EvaluationResult, PropertyBindings, CreatedObjects, Realm } from "../realm.js";
import { Effects } from "../realm.js";
import type { Descriptor, PropertyBinding } from "../types.js";

import { AbruptCompletion, PossiblyNormalCompletion } from "../completions.js";
import { Reference } from "../environment.js";
import { cloneDescriptor, equalDescriptors, IsDataDescriptor, StrictEqualityComparison } from "../methods/index.js";
import { Generator } from "../utils/generator.js";
import { AbstractValue, ArrayValue, EmptyValue, ObjectValue, Value } from "../values/index.js";

import invariant from "../invariant.js";
import * as t from "babel-types";

export class WidenImplementation {
  _widenArrays(
    realm: Realm,
    v1: Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    v2: Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>
  ): Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
    if (v1[0] instanceof Value) {
      invariant(v2[0] instanceof Value);
      return this._widenArraysOfValues(realm, (v1: any), (v2: any));
    }
    invariant(!(v2[0] instanceof Value));
    return this._widenArrayOfsMapEntries(realm, (v1: any), (v2: any));
  }

  _widenArrayOfsMapEntries(
    realm: Realm,
    a1: Array<{ $Key: void | Value, $Value: void | Value }>,
    a2: Array<{ $Key: void | Value, $Value: void | Value }>
  ): Array<{ $Key: void | Value, $Value: void | Value }> {
    let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
    let result: Array<{ $Key: void | Value, $Value: void | Value }> = [];
    for (let i = 0; i < n; i++) {
      let { $Key: key1, $Value: val1 } = a1[i] || { $Key: undefined, $Value: undefined };
      let { $Key: key2, $Value: val2 } = a2[i] || { $Key: undefined, $Value: undefined };
      if (key1 === undefined && key2 === undefined) {
        result[i] = { $Key: undefined, $Value: undefined };
      } else {
        if (key1 === undefined) key1 = key2;
        else if (key2 === undefined) key2 = key1;
        invariant(key1 !== undefined);
        invariant(key2 !== undefined);
        let key3 = this.widenValues(realm, key1, key2);
        invariant(key3 instanceof Value);
        if (val1 === undefined && val2 === undefined) {
          result[i] = { $Key: key3, $Value: undefined };
        } else {
          if (val1 === undefined) val1 = val2;
          else if (val2 === undefined) val2 = val1;
          invariant(val1 !== undefined);
          invariant(val2 !== undefined);
          let val3 = this.widenValues(realm, val1, val2);
          invariant(val3 === undefined || val3 instanceof Value);
          result[i] = { $Key: key3, $Value: val3 };
        }
      }
    }
    return result;
  }

  _widenArraysOfValues(realm: Realm, a1: Array<Value>, a2: Array<Value>): Array<Value> {
    let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
    let result = [];
    for (let i = 0; i < n; i++) {
      let wv = this.widenValues(realm, a1[i], a2[i]);
      invariant(wv === undefined || wv instanceof Value);
      result[i] = wv;
    }
    return result;
  }

  // Returns a new effects summary that includes both e1 and e2.
  widenEffects(realm: Realm, e1: Effects, e2: Effects): Effects {
    let [result1, , bindings1, properties1, createdObj1] = e1.data;
    let [result2, , bindings2, properties2, createdObj2] = e2.data;

    let result = this.widenResults(realm, result1, result2);
    let bindings = this.widenBindings(realm, bindings1, bindings2);
    let properties = this.widenPropertyBindings(realm, properties1, properties2, createdObj1, createdObj2);
    let createdObjects = new Set(); // Top, since the empty set knows nothing. There is no other choice for widen.
    let generator = new Generator(realm, "widen"); // code subject to widening will be generated somewhere else
    return new Effects(result, generator, bindings, properties, createdObjects);
  }

  widenResults(realm: Realm, result1: EvaluationResult, result2: EvaluationResult): PossiblyNormalCompletion | Value {
    invariant(!(result1 instanceof Reference || result2 instanceof Reference), "loop bodies should not result in refs");
    invariant(
      !(result1 instanceof AbruptCompletion || result2 instanceof AbruptCompletion),
      "if a loop iteration ends abruptly, there is no need for fixed point computation"
    );
    if (result1 instanceof Value && result2 instanceof Value) {
      let val = this.widenValues(realm, result1, result2);
      invariant(val instanceof Value);
      return val;
    }
    if (result1 instanceof PossiblyNormalCompletion || result2 instanceof PossiblyNormalCompletion) {
      //todo: #1174 figure out how to deal with loops that have embedded conditional exits
      // widen join pathConditions
      // widen normal result and Effects
      // use abrupt part of result2, depend stability to make this safe. See below.
      throw new FatalError();
    }
    invariant(false);
  }

  widenMaps<K, V>(m1: Map<K, V>, m2: Map<K, V>, widen: (K, void | V, void | V) => V): Map<K, V> {
    let m3: Map<K, V> = new Map();
    m1.forEach((val1, key, map1) => {
      let val2 = m2.get(key);
      let val3 = widen(key, val1, val2);
      m3.set(key, val3);
    });
    m2.forEach((val2, key, map2) => {
      if (!m1.has(key)) {
        m3.set(key, widen(key, undefined, val2));
      }
    });
    return m3;
  }

  widenBindings(realm: Realm, m1: Bindings, m2: Bindings): Bindings {
    let widen = (b: Binding, b1: void | BindingEntry, b2: void | BindingEntry) => {
      let l1 = b1 === undefined ? b.hasLeaked : b1.hasLeaked;
      let l2 = b2 === undefined ? b.hasLeaked : b2.hasLeaked;
      let hasLeaked = l1 || l2; // If either has leaked, then this binding has leaked.
      let v1 = b1 === undefined || b1.value === undefined ? b.value : b1.value;
      invariant(b2 !== undefined); // Local variables are not going to get deleted as a result of widening
      let v2 = b2.value;
      invariant(v2 !== undefined);
      let result = this.widenValues(realm, v1 || realm.intrinsics.undefined, v2);
      if (result instanceof AbstractValue && result.kind === "widened") {
        let phiNode = b.phiNode;
        if (phiNode === undefined) {
          // Create a temporal location for binding
          let generator = realm.generator;
          invariant(generator !== undefined);
          phiNode = generator.deriveAbstract(
            result.types,
            result.values,
            [b.value || realm.intrinsics.undefined],
            ([n]) => n,
            { skipInvariant: true }
          );
          b.phiNode = phiNode;
        }
        // Let the widened value be a reference to the phiNode of the binding
        invariant(phiNode.intrinsicName !== undefined);
        let phiName = phiNode.intrinsicName;
        result.intrinsicName = phiName;
        result._buildNode = args => t.identifier(phiName);
      }
      invariant(result instanceof Value);
      return { hasLeaked, value: result };
    };
    return this.widenMaps(m1, m2, widen);
  }

  // Returns an abstract value that includes both v1 and v2 as potential values.
  widenValues(
    realm: Realm,
    v1: Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    v2: Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>
  ): Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
    if (Array.isArray(v1) || Array.isArray(v2)) {
      invariant(Array.isArray(v1));
      invariant(Array.isArray(v2));
      return this._widenArrays(realm, ((v1: any): Array<Value>), ((v2: any): Array<Value>));
    }
    invariant(v1 instanceof Value);
    invariant(v2 instanceof Value);
    if (
      !(v1 instanceof AbstractValue) &&
      !(v2 instanceof AbstractValue) &&
      StrictEqualityComparison(realm, v1.throwIfNotConcrete(), v2.throwIfNotConcrete())
    ) {
      return v1; // no need to widen a loop invariant value
    } else {
      invariant(v1 && v2);
      return AbstractValue.createFromWidening(realm, v1, v2);
    }
  }

  widenPropertyBindings(
    realm: Realm,
    m1: PropertyBindings,
    m2: PropertyBindings,
    c1: CreatedObjects,
    c2: CreatedObjects
  ): PropertyBindings {
    let widen = (b: PropertyBinding, d1: void | Descriptor, d2: void | Descriptor) => {
      if (d1 === undefined && d2 === undefined) return undefined;
      // If the PropertyBinding object has been freshly allocated do not widen (that happens in AbstractObjectValue)
      if (d1 === undefined) {
        if (b.object instanceof ObjectValue && c2.has(b.object)) return d2; // no widen
        if (b.descriptor !== undefined && m1.has(b)) {
          // property was present in (n-1)th iteration and deleted in nth iteration
          d1 = cloneDescriptor(b.descriptor);
          invariant(d1 !== undefined);
          d1.value = realm.intrinsics.empty;
        } else {
          // no write to property in nth iteration, use the value from the (n-1)th iteration
          d1 = b.descriptor;
          if (d1 === undefined) {
            d1 = cloneDescriptor(d2);
            invariant(d1 !== undefined);
            d1.value = realm.intrinsics.empty;
          }
        }
      }
      if (d2 === undefined) {
        if (b.object instanceof ObjectValue && c1.has(b.object)) return d1; // no widen
        if (m2.has(b)) {
          // property was present in nth iteration and deleted in (n+1)th iteration
          d2 = cloneDescriptor(d1);
          invariant(d2 !== undefined);
          d2.value = realm.intrinsics.empty;
        } else {
          // no write to property in (n+1)th iteration, use the value from the nth iteration
          d2 = d1;
        }
        invariant(d2 !== undefined);
      }
      let result = this.widenDescriptors(realm, d1, d2);
      if (result && result.value instanceof AbstractValue && result.value.kind === "widened") {
        let rval = result.value;
        let pathNode = b.pathNode;
        if (pathNode === undefined) {
          //Since properties already have mutable storage locations associated with them, we do not
          //need phi nodes. What we need is an abstract value with a build node that results in a memberExpression
          //that resolves to the storage location of the property.

          // For now, we only handle loop invariant properties
          //i.e. properties where the member expresssion does not involve any values written to inside the loop.
          let key = b.key;
          if (
            typeof key === "string" ||
            (key instanceof AbstractValue && !(key.mightNotBeString() && key.mightNotBeNumber()))
          ) {
            if (typeof key === "string") {
              pathNode = AbstractValue.createFromWidenedProperty(realm, rval, [b.object], ([o]) =>
                t.memberExpression(o, t.identifier(key))
              );
            } else {
              invariant(key instanceof AbstractValue);
              pathNode = AbstractValue.createFromWidenedProperty(realm, rval, [b.object, key], ([o, p]) => {
                return t.memberExpression(o, p, true);
              });
            }
            // The value of the property at the start of the loop needs to be written to the property
            // before the loop commences, otherwise the memberExpression will result in an undefined value.
            let generator = realm.generator;
            invariant(generator !== undefined);
            let initVal = (b.descriptor && b.descriptor.value) || realm.intrinsics.empty;
            if (!(initVal instanceof Value)) throw new FatalError("todo: handle internal properties");
            if (!(initVal instanceof EmptyValue)) {
              if (key === "length" && b.object instanceof ArrayValue) {
                // do nothing, the array length will already be initialized
              } else if (typeof key === "string") {
                generator.emitVoidExpression(rval.types, rval.values, [b.object, initVal], ([o, v]) => {
                  invariant(typeof key === "string");
                  return t.assignmentExpression("=", t.memberExpression(o, t.identifier(key)), v);
                });
              } else {
                invariant(key instanceof AbstractValue);
                generator.emitVoidExpression(rval.types, rval.values, [b.object, key, initVal], ([o, p, v]) =>
                  t.assignmentExpression("=", t.memberExpression(o, p, true), v)
                );
              }
            }
          } else {
            throw new FatalError("todo: handle the case where key is an abstract value");
          }
          b.pathNode = pathNode;
        }
        result.value = pathNode;
      }
      return result;
    };
    return this.widenMaps(m1, m2, widen);
  }

  widenDescriptors(realm: Realm, d1: void | Descriptor, d2: Descriptor): void | Descriptor {
    if (d1 === undefined) {
      // d2 is a property written to only in the (n+1)th iteration
      if (!IsDataDescriptor(realm, d2)) return d2; // accessor properties need not be widened.
      let dc = cloneDescriptor(d2);
      invariant(dc !== undefined);
      let d2value = dc.value;
      invariant(d2value !== undefined); // because IsDataDescriptor is true for d2/dc
      dc.value = this.widenValues(realm, d2value, d2value);
      return dc;
    } else {
      if (equalDescriptors(d1, d2)) {
        if (!IsDataDescriptor(realm, d1)) return d1; // identical accessor properties need not be widened.
        // equalDescriptors plus IsDataDescriptor guarantee that both have value props and if you have a value prop is value is defined.
        let dc = cloneDescriptor(d1);
        invariant(dc !== undefined);
        let d1value = d1.value;
        invariant(d1value !== undefined);
        let d2value = d2.value;
        invariant(d2value !== undefined);
        dc.value = this.widenValues(realm, d1value, d2value);
        return dc;
      }
      //todo: #1174 if we get here, the loop body contains a call to create a property and different iterations
      // create them differently. That seems beyond what a fixpoint computation can reasonably handle without
      // losing precision. Report an error here.
      throw new FatalError();
    }
  }

  // If e2 is the result of a loop iteration starting with effects e1 and it has a subset of elements of e1,
  // then we have reached a fixed point and no further calls to widen are needed. e1/e2 represent a general
  // summary of the loop, regardless of how many iterations will be performed at runtime.
  containsEffects(e1: Effects, e2: Effects): boolean {
    let [result1, , bindings1, properties1, createdObj1] = e1.data;
    let [result2, , bindings2, properties2, createdObj2] = e2.data;

    if (!this.containsResults(result1, result2)) return false;
    if (!this.containsBindings(bindings1, bindings2)) return false;
    if (!this.containsPropertyBindings(properties1, properties2, createdObj1, createdObj2)) return false;
    return true;
  }

  containsResults(result1: EvaluationResult, result2: EvaluationResult): boolean {
    if (result1 instanceof Value && result2 instanceof Value) return this._containsValues(result1, result2);
    return false;
  }

  containsMap<K, V>(m1: Map<K, V>, m2: Map<K, V>, f: (void | V, void | V) => boolean): boolean {
    for (const [key1, val1] of m1.entries()) {
      if (val1 === undefined) continue; // deleted
      let val2 = m2.get(key1);
      if (val2 === undefined) continue; // A key that disappears has been widened away into the unknown key
      if (!f(val1, val2)) return false;
    }
    for (const key2 of m2.keys()) {
      if (!m1.has(key2)) return false;
    }
    return true;
  }

  containsBindings(m1: Bindings, m2: Bindings): boolean {
    let containsBinding = (b1: void | BindingEntry, b2: void | BindingEntry) => {
      if (
        b1 === undefined ||
        b2 === undefined ||
        b1.value === undefined ||
        b2.value === undefined ||
        !this._containsValues(b1.value, b2.value) ||
        b1.hasLeaked !== b2.hasLeaked
      ) {
        return false;
      }
      return true;
    };
    return this.containsMap(m1, m2, containsBinding);
  }

  containsPropertyBindings(
    m1: PropertyBindings,
    m2: PropertyBindings,
    c1: CreatedObjects,
    c2: CreatedObjects
  ): boolean {
    let containsPropertyBinding = (d1: void | Descriptor, d2: void | Descriptor) => {
      let [v1, v2] = [d1 && d1.value, d2 && d2.value];
      if (v1 === undefined) {
        return v2 === undefined;
      }
      if (v1 instanceof Value && v2 instanceof Value) return this._containsValues(v1, v2);
      if (Array.isArray(v1) && Array.isArray(v2)) {
        return this._containsArray(((v1: any): Array<Value>), ((v2: any): Array<Value>));
      }
      return v2 === undefined;
    };
    for (const [key1, val1] of m1.entries()) {
      if (val1 === undefined) continue; // deleted
      let val2 = m2.get(key1);
      if (val2 === undefined) continue; // A key that disappears has been widened away into the unknown key
      if (key1.object instanceof ObjectValue && c1.has(key1.object)) {
        continue;
      }
      if (!containsPropertyBinding(val1, val2)) return false;
    }
    for (const key2 of m2.keys()) {
      if (key2.object instanceof ObjectValue && c2.has(key2.object)) {
        continue;
      }
      if (!m1.has(key2)) return false;
    }
    return true;
  }

  _containsArray(
    v1: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    v2: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>
  ): boolean {
    let e = (v1 && v1[0]) || (v2 && v2[0]);
    if (e instanceof Value) return this.containsArraysOfValue((v1: any), (v2: any));
    else return this._containsArrayOfsMapEntries((v1: any), (v2: any));
  }

  _containsArrayOfsMapEntries(
    realm: Realm,
    a1: void | Array<{ $Key: void | Value, $Value: void | Value }>,
    a2: void | Array<{ $Key: void | Value, $Value: void | Value }>
  ): boolean {
    let empty = realm.intrinsics.empty;
    let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
    for (let i = 0; i < n; i++) {
      let { $Key: key1, $Value: val1 } = (a1 && a1[i]) || { $Key: empty, $Value: empty };
      let { $Key: key2, $Value: val2 } = (a2 && a2[i]) || { $Key: empty, $Value: empty };
      if (key1 === undefined) {
        if (key2 !== undefined) return false;
      } else {
        if (key1 instanceof Value && key2 instanceof Value && key1.equals(key2)) {
          if (val1 instanceof Value && val2 instanceof Value && this._containsValues(val1, val2)) continue;
        }
        return false;
      }
    }
    return true;
  }

  containsArraysOfValue(realm: Realm, a1: void | Array<Value>, a2: void | Array<Value>): boolean {
    let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
    for (let i = 0; i < n; i++) {
      let [val1, val2] = [a1 && a1[i], a2 && a2[i]];
      if (val1 instanceof Value && val2 instanceof Value && !this._containsValues(val1, val2)) return false;
    }
    return true;
  }

  _containsValues(val1: Value, val2: Value) {
    if (val1 instanceof AbstractValue) {
      if (
        !Value.isTypeCompatibleWith(val2.getType(), val1.getType()) &&
        !Value.isTypeCompatibleWith(val1.getType(), val2.getType())
      )
        return false;
      return val1.values.containsValue(val2);
    }
    return val1.equals(val2);
  }
}
