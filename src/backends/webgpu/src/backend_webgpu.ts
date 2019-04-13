/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {DataMover, DataType, KernelBackend, Rank, ShapeMap, Tensor, tensor1d, Tensor3D, util} from '@tensorflow/tfjs-core';

import {MatMulProgram} from './kernels/matmul_webgpu';
import {MultiplyProgram} from './kernels/multiply_webgpu';
import * as webgpu_math from './kernels/webgpu_math';
import {WebGPUBinary} from './kernels/webgpu_math';

type TensorInfo = {
  shape: number[],
  dtype: DataType,
  values: Float32Array|Int32Array|Uint8Array,
  id: number,
  buffer?: any,  // WebGPUBuffer
};

interface DataId {}

declare const GPUBufferUsage: any;
declare const GPUShaderStageBit: any;

export class WebGPUBackend extends KernelBackend {
  device: any;
  queue: any;
  shaderc: any;
  compiler: any;
  compileOpts: any;

  private binaryCache: {[key: string]: WebGPUBinary};

  constructor(device: any, shaderc: any) {
    super();
    this.binaryCache = {};
    this.device = device;
    this.queue = device.getQueue();
    this.shaderc = shaderc;
    this.compiler = new shaderc.Compiler();
    this.compileOpts = new shaderc.CompileOptions();
  }

  floatPrecision(): number {
    return 32;
  }

  setDataMover(dataMover: DataMover): void {
    // TODO: tfjs team to implement this.
  }

  private tensorMap = new WeakMap<DataId, TensorInfo>();

  disposeData(dataId: DataId): void {
    // Tensor disposal logic.
  }

  private createBuffer(size: number) {
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.TRANSFER_SRC | GPUBufferUsage.TRANSFER_DST |
          GPUBufferUsage.STORAGE,
    });
  }

  private setBufferData(buffer: any, data: Float32Array|Int32Array|Uint8Array) {
    buffer.setSubData(0, data.slice().buffer);
  }

  register(dataId: object, shape: number[], dtype: DataType): void {
    if (!this.tensorMap.has(dataId)) {
      const buffer = this.createBuffer(
          util.sizeFromShape(shape) * util.bytesPerElement(dtype));

      this.tensorMap.set(dataId, {shape, dtype, values: null, id: -1, buffer});
    }
  }

  write(dataId: object, values: Float32Array|Int32Array|Uint8Array): void {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }

    const info = this.tensorMap.get(dataId);
    info.values = values;
    this.setBufferData(info.buffer, values);
    this.tensorMap.set(dataId, info);
  }

  async getBufferData(info: TensorInfo): Promise<ArrayBuffer> {
    const size =
        util.sizeFromShape(info.shape) * util.bytesPerElement(info.dtype);
    const staging = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.TRANSFER_DST | GPUBufferUsage.MAP_READ,
    });
    {
      const encoder = this.device.createCommandEncoder({});
      encoder.copyBufferToBuffer(info.buffer, 0, staging, 0, size);
      this.queue.submit([encoder.finish()]);
    }
    const mapped: ArrayBuffer = await staging.mapReadAsync();

    const data = mapped.slice(0);
    info.buffer.unmap();

    return data;
  }

  async read(dataId: object): Promise<Float32Array|Int32Array|Uint8Array> {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }
    const info = this.tensorMap.get(dataId);
    const data = await this.getBufferData(info);

    return new Float32Array(data);
  }

  getAndSavePipeline(key: string, getBinary: () => any) {
    if (!(key in this.binaryCache)) {
      this.binaryCache[key] = getBinary();
    }
    return this.binaryCache[key];
  }

  public compileAndRun(
      program: webgpu_math.WebGPUProgram, inputs: any[], output: Tensor) {
    const key = webgpu_math.makeShaderKey(program);
    const bindings = inputs.concat(output).map((input: any, idx: number) => {
      return {
        binding: idx,
        visibility: GPUShaderStageBit.COMPUTE,
        type: 'storage-buffer'
      };
    });
    const {bindGroupLayout, pipeline} = this.getAndSavePipeline(key, () => {
      return webgpu_math.compileProgram(
          this.compiler, this.shaderc.shader_kind.compute, this.compileOpts,
          this.device, program, bindings);
    });

    // TODO: bind groups should be cached.
    const bg = this.device.createBindGroup({
      layout: bindGroupLayout,
      bindings: inputs.concat(output).map((tensor, i: number) => {
        const tensorData = this.tensorMap.get(tensor.dataId);

        return {
          binding: i,
          resource: {
            offset: 0,
            size: tensor.size * util.bytesPerElement(tensor.dtype),
            buffer: tensorData.buffer
          }
        };
      })
    });

    const encoder = this.device.createCommandEncoder({});
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatch(...program.dispatch);
    pass.endPass();
    this.queue.submit([encoder.finish()]);
    return output;
  }

  multiply(a: Tensor, b: Tensor): Tensor {
    const output = Tensor.make(a.shape, {}, a.dtype, this);
    const program = new MultiplyProgram(output.shape);

    return this.compileAndRun(program, [a, b], output) as Tensor;
  }

  reshape<R extends Rank>(x: Tensor, shape: ShapeMap[R]): Tensor<R> {
    return Tensor.make(shape, {dataId: x.dataId}, x.dtype);
  }

  batchMatMul(
      a: Tensor3D, b: Tensor3D, transposeA: boolean,
      transposeB: boolean): Tensor3D {
    const outerShapeA = transposeA ? a.shape[2] : a.shape[1];
    const outerShapeB = transposeB ? b.shape[1] : b.shape[2];
    const sharedDim = transposeA ? a.shape[1] : a.shape[2];
    const [batch, , ] = a.shape;

    const output =
        Tensor.make([batch, outerShapeA, outerShapeB], {}, a.dtype, this) as
        Tensor3D;

    const program = new MatMulProgram(output.shape);
    const mnkb =
        tensor1d([outerShapeA, sharedDim, outerShapeB, batch], 'int32');
    // TODO: dispose mnkb

    return this.compileAndRun(program, [a, b, mnkb], output) as Tensor3D;
  }
}