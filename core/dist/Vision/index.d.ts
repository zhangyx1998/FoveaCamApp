// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { Awaitable, TypedArray, CoreObject } from "../types";
import type { Size, Point2d, Point3d, Rect } from "core/Geometry";

declare module "core/Vision" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  export type Mat<A extends TypedArray = TypedArray> = A & {
    // Mat.length === shape.reduce((a, b) => a * b, channels)
    shape: number[];
    channels: number;
  };

  export type CameraCalibration = {
    date: Date;
    // Sensor Size - width x height in pixels
    sensor_size: Size;
    // Camera Matrix - 3 row x 3 col
    camera_matrix: Mat<Float64Array>;
    // Distortion coefficients - 1 row x N col
    dist_coeffs: Mat<Float64Array>;
    // Rectification transform vectors - 3 row x 3 col
    rvecs: Mat<Float64Array>[];
    // Projection transform vectors - 3 row x 4 col
    tvecs: Mat<Float64Array>[];
    // Overall RMS re-projection error from cv::calibrateCamera (0 for
    // calibrations persisted before this field existed).
    rms: number;
  };

  // Default: { max_count: 30, epsilon: 1e-8 }
  export type TermCriteria = {
    // Type is auto deducted.
    max_count?: number;
    epsilon?: number;
  };

  export class Undistort {
    constructor(calibration: CameraCalibration);
    readonly calibration: CameraCalibration;
    get sensor_size(): Size;
    get focal(): Point2d;
    get center(): Point2d;
    get fov(): Point2d; // X and Y field of view in radians
    apply<T extends Mat>(mat: T): T;
    undistort(points: Point2d[]): Point2d[];
    distort(points: Point2d[]): Point2d[];
    angular(
      points: Point2d[],
      undistort?: boolean, // default: false
    ): Point2d[];
    position(
      angles: Point2d[],
      distort?: boolean, // default: false
    ): Point2d[];
  }

  export type Pixel = Point2d & { value: number };

  export function load(path: string): Promise<Mat<Uint8Array>>;
  export function loadSync(path: string): Mat<Uint8Array>;
  export function save<T extends Mat>(mat: T, path: string): Promise<boolean>;
  export function saveSync<T extends Mat>(mat: T, path: string): boolean;

  /**
   * When alpha and beta are not provided, the function automatically derives
   * them to scale the input values to the full range of the target type.
   * For example, when converting from 16-bit unsigned to 8-bit unsigned,
   * alpha would be set to 255/65535 and beta would be set to 0.
   * Specially, for floating-point target types, value range follows the
   * convention of [0.0, 1.0].
   */
  export function convertType(
    mat: Mat,
    type: "8U",
    alpha?: number,
    beta?: number,
  ): Mat<Uint8Array>;
  export function convertType(
    mat: Mat,
    type: "16U",
    alpha?: number,
    beta?: number,
  ): Mat<Uint16Array>;
  export function convertType(
    mat: Mat,
    type: "16S",
    alpha?: number,
    beta?: number,
  ): Mat<Int16Array>;
  export function convertType(
    mat: Mat,
    type: "32S",
    alpha?: number,
    beta?: number,
  ): Mat<Int32Array>;
  export function convertType(
    mat: Mat,
    type: "16F",
    alpha?: number,
    beta?: number,
  ): Mat<Float32Array>;
  export function convertType(
    mat: Mat,
    type: "32F",
    alpha?: number,
    beta?: number,
  ): Mat<Float32Array>;
  export function convertType(
    mat: Mat,
    type: "64F",
    alpha?: number,
    beta?: number,
  ): Mat<Float64Array>;

  export function cvtColor<T extends Mat>(mat: T, code: CvtColorCode): T;

  export function slice<T extends Mat>(mat: T, rect: Rect): T;

  export function resize<T extends Mat>(
    mat: T,
    size?: Partial<Size> | null,
    fx?: number | null,
    fy?: number | null,
    mode?: InterpolationFlag, // default: "LINEAR"
  ): Awaitable<T>;

  export function heatmap(
    mat: Mat,
    norm?: boolean, // default: false
  ): Mat<Uint8Array>; // RGBA8

  export function gaussian<T extends Mat>(
    mat: T,
    ksize: Size | number,
    sigmaX?: number, // default: 2
    sigmaY?: number, // default: sigmaX
  ): T;

  export function diff<T extends Mat>(
    a: T,
    b: T,
    norm?: boolean, // default: false
  ): Mat<Uint8Array>;

  export function minMaxLoc(
    mat: Mat,
  ): [Pixel, Pixel] & { min: Pixel; max: Pixel };

  export function matchTemplate(
    haystack: Mat,
    needle: Mat,
    method?: TemplateMatchMode, // default: "SQDIFF_NORMED"
  ): Promise<Mat<Float32Array>>;

  export function findChessboardCorners(
    mat: Mat,
    pattern_size: Size | number,
  ): Promise<Point2d[]>;

  export function cornerSubPix(
    mat: Mat,
    corners: Point2d[],
    win_size?: Size | number | null, // default 5
    zero_zone?: Size | number | null, // default -1
    term_criteria?: TermCriteria | null, // default: refer to TermCriteria
  ): Promise<Point2d[]>;

  export function calibrateCamera(
    sensor_size: Size,
    img_points: Point2d[][],
    obj_points: Point3d[][],
    term_criteria?: TermCriteria | null, // default: refer to TermCriteria
  ): Promise<CameraCalibration>;

  /**
   * Finds a perspective transformation between two planes.
   * @param src_points Coordinates of the points in the original plane
   * @param dst_points Coordinates of the points in the target plane
   * @param method Method used to compute homography (default: RANSAC)
   * @param ransacReprojThreshold Maximum allowed reprojection error (default: 3.0)
   * @param maxIters Maximum number of RANSAC iterations (default: 2000)
   * @param confidence Confidence level (default: 0.995)
   * @returns 3x3 homography matrix
   */
  export function findHomography(
    src_points: Point2d[],
    dst_points: Point2d[],
    method?: HomographyMethod, // default: "RANSAC"
    ransacReprojThreshold?: number, // default: 3.0
    maxIters?: number, // default: 2000
    confidence?: number, // default: 0.995
  ): Mat<Float64Array>;

  /**
   * Performs the perspective transformation of 2D points using a homography matrix.
   * @param homography 3x3 homography matrix
   * @param points Array of 2D points to transform
   * @returns Transformed 2D points
   */
  export function projectHomography(
    homography: Mat<Float64Array>,
    points: Point2d[],
  ): Point2d[];

  /**
   * Applies a perspective transformation to an image.
   * @param src Source image
   * @param homography 3x3 transformation matrix
   * @param flags Interpolation method (default: LINEAR)
   * @returns Transformed image with same size as source. Uses BORDER_TRANSPARENT mode.
   */
  export function wrapPerspective<T extends Mat>(
    src: T,
    homography: Mat<Float64Array>,
    flags?: InterpolationFlag, // default: "LINEAR"
  ): T;

  export function disparity<T extends Mat>(
    left: T,
    right: T,
    numDisparities?: number, // default: 0
    blockSize?: number, // default: 21
    // Signed search window floor (depth-view-legacy-stereobm, 2026-07-11):
    // foveated gaze makes true disparity signed — pass a negative floor
    // (sgbm-signed-range.md window) to search −W…+W. Default 0 = legacy.
    minDisparity?: number,
  ): Mat<TypedArray>;

  export function reprojectImageTo3D<T extends Mat>(
    disparity: T,
    Q: Mat<Float64Array>,
    handleMissingValues?: boolean, // default: false
    ddepth?: number, // default: -1 (same as disparity)
  ): T;

  export function depthFromProjection<T extends Mat>(
    depth: T,
    near?: number, // default: -Infinity
    far?: number, // default: Infinity
  ): Mat<Uint16Array>;

  export class MarkerDetector extends CoreObject<MarkerDetector> {
    constructor(type: PreDefinedDictionary);
    detect(
      frame: Frame,
      scale?: number, // default 1.0
    ): Promise<MarkerDetectResults>;
    stream(
      stream: Stream<Frame>,
      scale?: number, // default 1.0
    ): Stream<MarkerDetectResults>;
    pattern(id: number): (0 | 1)[][] & Size;
  }

  export type MarkerDetectResult = { id: number } & Size & Point2d[];
  export type MarkerDetectResults = MarkerDetectResult[] & { frame: Frame };

  type PreDefinedDictionary =
    | "4X4_50"
    | "4X4_100"
    | "4X4_250"
    | "4X4_1000"
    | "5X5_50"
    | "5X5_100"
    | "5X5_250"
    | "5X5_1000"
    | "6X6_50"
    | "6X6_100"
    | "6X6_250"
    | "6X6_1000"
    | "7X7_50"
    | "7X7_100"
    | "7X7_250"
    | "7X7_1000"
    | "ARUCO_ORIGINAL"
    | "APRILTAG_16h5"
    | "APRILTAG_25h9"
    | "APRILTAG_36h10"
    | "APRILTAG_36h11"
    | "ARUCO_MIP_36h12";

  export class Projector extends CoreObject<Projector> {
    /**
     * Finds an object pose from 3D-2D point correspondences.
     * @param img_points Array of corresponding 2D image points
     * @param obj_points Array of 3D object points
     * @param calibration Camera calibration data (optional - uses identity matrix if not provided)
     * @param use_extrinsic_guess Use initial guess for rvec/tvec (default: false)
     * @param method Method to use (default: ITERATIVE)
     * @returns Object containing rvec (rotation vector) and tvec (translation vector)
     */
    static solve(
      img_points: Point2d[],
      obj_points: Point3d[],
      calibration?: CameraCalibration | null,
      use_extrinsic_guess?: boolean,
      method?: SolvePnPMethod, // default: "ITERATIVE"
    ): Promise<Projector>;
    get rvec(): Mat<Float64Array>;
    get tvec(): Mat<Float64Array>;
    get mtx(): Mat<Float64Array>;
    get dist(): Mat<Float64Array>;
    obj2img(obj_points: Point3d[]): Point2d[];
    img2obj(
      img_points: Point2d[],
      z?: number, // default: 0
    ): Point3d[];
  }

  type CvtColorCode =
    | number
    | "BGR2BGRA"
    | "RGB2RGBA"
    | "BGRA2BGR"
    | "RGBA2RGB"
    | "BGR2RGBA"
    | "RGB2BGRA"
    | "RGBA2BGR"
    | "BGRA2RGB"
    | "BGR2RGB"
    | "RGB2BGR"
    | "BGRA2RGBA"
    | "RGBA2BGRA"
    | "BGR2GRAY"
    | "RGB2GRAY"
    | "GRAY2BGR"
    | "GRAY2RGB"
    | "GRAY2BGRA"
    | "GRAY2RGBA"
    | "BGRA2GRAY"
    | "RGBA2GRAY"
    | "BayerBG2BGR"
    | "BayerGB2BGR"
    | "BayerRG2BGR"
    | "BayerGR2BGR"
    | "BayerRGGB2BGR"
    | "BayerGRBG2BGR"
    | "BayerBGGR2BGR"
    | "BayerGBRG2BGR"
    | "BayerRGGB2RGB"
    | "BayerGRBG2RGB"
    | "BayerBGGR2RGB"
    | "BayerGBRG2RGB"
    | "BayerBG2RGB"
    | "BayerGB2RGB"
    | "BayerRG2RGB"
    | "BayerGR2RGB"
    | "BayerBG2GRAY"
    | "BayerGB2GRAY"
    | "BayerRG2GRAY"
    | "BayerGR2GRAY"
    | "BayerRGGB2GRAY"
    | "BayerGRBG2GRAY"
    | "BayerBGGR2GRAY"
    | "BayerGBRG2GRAY";

  type SolvePnPMethod =
    | "ITERATIVE"
    | "EPNP"
    | "P3P"
    | "DLS"
    | "UPNP"
    | "AP3P"
    | "IPPE"
    | "IPPE_SQUARE"
    | "SQPNP";

  type HomographyMethod =
    | "REGULAR" // All points used (0)
    | "RANSAC" // RANSAC-based robust method
    | "LMEDS" // Least-Median robust method
    | "RHO"; // PROSAC-based robust method

  type InterpolationFlag = "NEAREST" | "LINEAR" | "CUBIC" | "AREA" | "LANCZOS4";

  type TemplateMatchMode =
    | "SQDIFF"
    | "SQDIFF_NORMED"
    | "CCORR"
    | "CCORR_NORMED"
    | "CCOEFF"
    | "CCOEFF_NORMED";
}
