
/**
 * @module encoding
 */
/*
 * We use the first five bits in the info flag for determining the type of the struct.
 *
 * 0: GC
 * 1: Item with Deleted content
 * 2: Item with JSON content
 * 3: Item with Binary content
 * 4: Item with String content
 * 5: Item with Embed content (for richtext content)
 * 6: Item with Format content (a formatting marker for richtext content)
 * 7: Item with Type
 */

import {
  findIndexSS,
  getState,
  createID,
  getStateVector,
  readAndApplyDeleteSet,
  writeDeleteSet,
  createDeleteSetFromStructStore,
  transact,
  readItemContent,
  UpdateDecoderV1,
  UpdateDecoderV2,
  UpdateEncoderV1,
  UpdateEncoderV2,
  DSDecoderV2,
  DSEncoderV2,
  DSDecoderV1,
  DSEncoderV1,
  AbstractDSEncoder, AbstractDSDecoder, AbstractUpdateEncoder, AbstractUpdateDecoder, AbstractContent, Doc, Transaction, GC, Item, StructStore, ID // eslint-disable-line
} from '../internals.js'

import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import * as binary from 'lib0/binary.js'

export let DefaultDSEncoder = DSEncoderV1
export let DefaultDSDecoder = DSDecoderV1
export let DefaultUpdateEncoder = UpdateEncoderV1
export let DefaultUpdateDecoder = UpdateDecoderV1

export const useV2Encoding = () => {
  DefaultDSEncoder = DSEncoderV2
  DefaultDSDecoder = DSDecoderV2
  DefaultUpdateEncoder = UpdateEncoderV2
  DefaultUpdateDecoder = UpdateDecoderV2
}

/**
 * @param {AbstractUpdateEncoder} encoder
 * @param {Array<GC|Item>} structs All structs by `client`
 * @param {number} client
 * @param {number} clock write structs starting with `ID(client,clock)`
 *
 * @function
 */
const writeStructs = (encoder, structs, client, clock) => {
  // write first id
  const startNewStructs = findIndexSS(structs, clock)
  // write # encoded structs
  encoding.writeVarUint(encoder.restEncoder, structs.length - startNewStructs)
  encoder.writeClient(client)
  encoding.writeVarUint(encoder.restEncoder, clock)
  const firstStruct = structs[startNewStructs]
  // write first struct with an offset
  firstStruct.write(encoder, clock - firstStruct.id.clock)
  for (let i = startNewStructs + 1; i < structs.length; i++) {
    structs[i].write(encoder, 0)
  }
}

/**
 * @param {AbstractUpdateEncoder} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 *
 * @private
 * @function
 */
export const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm
  const sm = new Map()
  _sm.forEach((clock, client) => {
    // only write if new structs are available
    if (getState(store, client) > clock) {
      sm.set(client, clock)
    }
  })
  getStateVector(store).forEach((clock, client) => {
    if (!_sm.has(client)) {
      sm.set(client, 0)
    }
  })
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, sm.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  Array.from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    // @ts-ignore
    writeStructs(encoder, store.clients.get(client), client, clock)
  })
}

/**
 * @param {AbstractUpdateDecoder} decoder The decoder object to read data from.
 * @param {Map<number,Array<GC|Item>>} clientRefs
 * @param {Doc} doc
 * @return {Map<number,Array<GC|Item>>}
 *
 * @private
 * @function
 */
export const readClientsStructRefs = (decoder, clientRefs, doc) => {
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding.readVarUint(decoder.restDecoder)
    /**
     * @type {Array<GC|Item>}
     */
    const refs = []
    const client = decoder.readClient()
    let clock = decoding.readVarUint(decoder.restDecoder)
    clientRefs.set(client, refs)
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo()
      if ((binary.BITS5 & info) !== 0) {
        /**
         * The item that was originally to the left of this item.
         * @type {ID | null}
         */
        const origin = (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null
        /**
         * The item that was originally to the right of this item.
         * @type {ID | null}
         */
        const rightOrigin = (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null
        const canCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
        const hasParentYKey = canCopyParentInfo ? decoder.readParentInfo() : false
        /**
         * If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
         * and we read the next string as parentYKey.
         * It indicates how we store/retrieve parent from `y.share`
         * @type {string|null}
         */
        const parentYKey = canCopyParentInfo && hasParentYKey ? decoder.readString() : null

        const struct = new Item(
          createID(client, clock), null, origin, null, rightOrigin,
          canCopyParentInfo && !hasParentYKey ? decoder.readLeftID() : (parentYKey !== null ? doc.get(parentYKey) : null), // parent
          canCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
          /** @type {AbstractContent} */ (readItemContent(decoder, info)) // item content
        )
        refs.push(struct)
        clock += struct.length
      } else {
        const len = decoder.readLen()
        refs.push(new GC(createID(client, clock), len))
        clock += len
      }
    }
  }
  return clientRefs
}

/**
 * Resume computing structs generated by struct readers.
 *
 * While there is something to do, we integrate structs in this order
 * 1. top element on stack, if stack is not empty
 * 2. next element from current struct reader (if empty, use next struct reader)
 *
 * If struct causally depends on another struct (ref.missing), we put next reader of
 * `ref.id.client` on top of stack.
 *
 * At some point we find a struct that has no causal dependencies,
 * then we start emptying the stack.
 *
 * It is not possible to have circles: i.e. struct1 (from client1) depends on struct2 (from client2)
 * depends on struct3 (from client1). Therefore the max stack size is eqaul to `structReaders.length`.
 *
 * This method is implemented in a way so that we can resume computation if this update
 * causally depends on another update.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
const resumeStructIntegration = (transaction, store) => {
  const stack = store.pendingStack
  const clientsStructRefs = store.pendingClientsStructRefs
  // sort them so that we take the higher id first, in case of conflicts the lower id will probably not conflict with the id from the higher user.
  const clientsStructRefsIds = Array.from(clientsStructRefs.keys()).sort((a, b) => a - b)
  let curStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]))
  // iterate over all struct readers until we are done
  while (stack.length !== 0 || clientsStructRefsIds.length > 0) {
    if (stack.length === 0) {
      // take any first struct from clientsStructRefs and put it on the stack
      if (curStructsTarget.i < curStructsTarget.refs.length) {
        stack.push(curStructsTarget.refs[curStructsTarget.i++])
      } else {
        clientsStructRefsIds.pop()
        if (clientsStructRefsIds.length > 0) {
          curStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]))
        }
        continue
      }
    }
    const ref = stack[stack.length - 1]
    const refID = ref.id
    const client = refID.client
    const refClock = refID.clock
    const localClock = getState(store, client)
    const offset = refClock < localClock ? localClock - refClock : 0
    if (refClock + offset !== localClock) {
      // A previous message from this client is missing
      // check if there is a pending structRef with a smaller clock and switch them
      const structRefs = clientsStructRefs.get(client) || { refs: [], i: 0 }
      if (structRefs.refs.length !== structRefs.i) {
        const r = structRefs.refs[structRefs.i]
        if (r.id.clock < refClock) {
          // put ref with smaller clock on stack instead and continue
          structRefs.refs[structRefs.i] = ref
          stack[stack.length - 1] = r
          // sort the set because this approach might bring the list out of order
          structRefs.refs = structRefs.refs.slice(structRefs.i).sort((r1, r2) => r1.id.clock - r2.id.clock)
          structRefs.i = 0
          continue
        }
      }
      // wait until missing struct is available
      return
    }
    const missing = ref.getMissing(transaction, store)
    if (missing !== null) {
      // get the struct reader that has the missing struct
      const structRefs = clientsStructRefs.get(missing) || { refs: [], i: 0 }
      if (structRefs.refs.length === structRefs.i) {
        // This update message causally depends on another update message.
        return
      }
      stack.push(structRefs.refs[structRefs.i++])
    } else {
      if (offset < ref.length) {
        ref.integrate(transaction, offset)
      }
      stack.pop()
    }
  }
  store.pendingClientsStructRefs.clear()
}

/**
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const tryResumePendingDeleteReaders = (transaction, store) => {
  const pendingReaders = store.pendingDeleteReaders
  store.pendingDeleteReaders = []
  for (let i = 0; i < pendingReaders.length; i++) {
    readAndApplyDeleteSet(pendingReaders[i], transaction, store)
  }
}

/**
 * @param {AbstractUpdateEncoder} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const writeStructsFromTransaction = (encoder, transaction) => writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState)

/**
 * @param {StructStore} store
 * @param {Map<number, Array<GC|Item>>} clientsStructsRefs
 *
 * @private
 * @function
 */
const mergeReadStructsIntoPendingReads = (store, clientsStructsRefs) => {
  const pendingClientsStructRefs = store.pendingClientsStructRefs
  clientsStructsRefs.forEach((structRefs, client) => {
    const pendingStructRefs = pendingClientsStructRefs.get(client)
    if (pendingStructRefs === undefined) {
      pendingClientsStructRefs.set(client, { refs: structRefs, i: 0 })
    } else {
      // merge into existing structRefs
      const merged = pendingStructRefs.i > 0 ? pendingStructRefs.refs.slice(pendingStructRefs.i) : pendingStructRefs.refs
      for (let i = 0; i < structRefs.length; i++) {
        merged.push(structRefs[i])
      }
      pendingStructRefs.i = 0
      pendingStructRefs.refs = merged.sort((r1, r2) => r1.id.clock - r2.id.clock)
    }
  })
}

/**
 * @param {Map<number,{refs:Array<GC|Item>,i:number}>} pendingClientsStructRefs
 */
const cleanupPendingStructs = pendingClientsStructRefs => {
  // cleanup pendingClientsStructs if not fully finished
  pendingClientsStructRefs.forEach((refs, client) => {
    if (refs.i === refs.refs.length) {
      pendingClientsStructRefs.delete(client)
    } else {
      refs.refs.splice(0, refs.i)
      refs.i = 0
    }
  })
}

/**
 * Read the next Item in a Decoder and fill this Item with the read data.
 *
 * This is called when data is received from a remote peer.
 *
 * @param {AbstractUpdateDecoder} decoder The decoder object to read data from.
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const readStructs = (decoder, transaction, store) => {
  const clientsStructRefs = new Map()
  readClientsStructRefs(decoder, clientsStructRefs, transaction.doc)
  mergeReadStructsIntoPendingReads(store, clientsStructRefs)
  resumeStructIntegration(transaction, store)
  cleanupPendingStructs(store.pendingClientsStructRefs)
  tryResumePendingDeleteReaders(transaction, store)
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts an decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {AbstractUpdateDecoder} [structDecoder]
 *
 * @function
 */
export const readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) =>
  transact(ydoc, transaction => {
    readStructs(structDecoder, transaction, ydoc.store)
    readAndApplyDeleteSet(structDecoder, transaction, ydoc.store)
  }, transactionOrigin, false)

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts an decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const readUpdate = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new DefaultUpdateDecoder(decoder))

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 *
 * @function
 */
export const applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
  const decoder = decoding.createDecoder(update)
  readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder))
}

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, DefaultUpdateDecoder)

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {AbstractUpdateEncoder} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
export const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  writeClientsStructs(encoder, doc.store, targetStateVector)
  writeDeleteSet(encoder, createDeleteSetFromStructStore(doc.store))
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @param {AbstractUpdateEncoder} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateAsUpdateV2 = (doc, encodedTargetStateVector, encoder = new UpdateEncoderV2()) => {
  const targetStateVector = encodedTargetStateVector == null ? new Map() : decodeStateVector(encodedTargetStateVector)
  writeStateAsUpdate(encoder, doc, targetStateVector)
  return encoder.toUint8Array()
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new DefaultUpdateEncoder())

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {AbstractDSDecoder} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const readStateVector = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder.restDecoder)
    const clock = decoding.readVarUint(decoder.restDecoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVectorV2 = decodedState => readStateVector(new DSDecoderV2(decoding.createDecoder(decodedState)))

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVector = decodedState => readStateVector(new DefaultDSDecoder(decoding.createDecoder(decodedState)))

/**
 * @param {AbstractDSEncoder} encoder
 * @param {Map<number,number>} sv
 * @function
 */
export const writeStateVector = (encoder, sv) => {
  encoding.writeVarUint(encoder.restEncoder, sv.size)
  sv.forEach((clock, client) => {
    encoding.writeVarUint(encoder.restEncoder, client) // @todo use a special client decoder that is based on mapping
    encoding.writeVarUint(encoder.restEncoder, clock)
  })
  return encoder
}

/**
 * @param {AbstractDSEncoder} encoder
 * @param {Doc} doc
 *
 * @function
 */
export const writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store))

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc} doc
 * @param {AbstractDSEncoder} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateVectorV2 = (doc, encoder = new DSEncoderV2()) => {
  writeDocumentStateVector(encoder, doc)
  return encoder.toUint8Array()
}

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc} doc
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateVector = doc => encodeStateVectorV2(doc, new DefaultDSEncoder())
