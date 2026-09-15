"use client";

import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { CountUp } from "countup.js";

const defaultFormatter = (value) => new Intl.NumberFormat().format(value);

export default function AnimatedNumber({
  value,
  formatter = defaultFormatter,
  decimalPlaces = 0,
  duration = 0.5,
  useEasing = true,
  prefix = "",
  suffix = "",
  className = "",
}) {
  const numericValue = Number(value) || 0;
  const elementRef = useRef(null);
  const countUpRef = useRef(null);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    countUpRef.current = new CountUp(elementRef.current, numericValue, {
      startVal: numericValue,
      decimalPlaces,
      duration,
      useEasing,
      formattingFn: (currentValue) => `${prefix}${formatter(currentValue)}${suffix}`,
    });

    return () => countUpRef.current?.onDestroy();
  }, [decimalPlaces, duration, formatter, prefix, suffix, useEasing]);

  useEffect(() => {
    const countUp = countUpRef.current;
    if (!countUp || countUp.error) return;

    if (reducedMotionRef.current) {
      countUp.onDestroy();
      countUp.startVal = numericValue;
      countUp.frameVal = numericValue;
      countUp.printValue(numericValue);
      return;
    }

    countUp.update(numericValue);
  }, [numericValue]);

  const formattedValue = `${prefix}${formatter(numericValue)}${suffix}`;

  return (
    <span ref={elementRef} className={`tabular-nums ${className}`} aria-label={formattedValue}>
      {formattedValue}
    </span>
  );
}

AnimatedNumber.propTypes = {
  value: PropTypes.number.isRequired,
  formatter: PropTypes.func,
  decimalPlaces: PropTypes.number,
  duration: PropTypes.number,
  useEasing: PropTypes.bool,
  prefix: PropTypes.string,
  suffix: PropTypes.string,
  className: PropTypes.string,
};
